using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 查询请求队列与执行泵（附录 B.6）：socket 读线程只校验、入队，pump 在主线程每帧最多执行一条。
    /// 队列上限 8、并发（在途）上限 8；排队 2000 ms / 执行 3000 ms 两段超时，超时立即
    /// <c>runtime.queryTimeout</c> 并作废请求；晚到结果丢弃、计入 dropped 并释放句柄。
    /// 锁纪律：持有 <see cref="Gate"/> 时不得回调调试 API / 业务实现，避免与会话锁互锁；
    /// 入队路径先读会话状态（会话锁）再加 <see cref="Gate"/>，顺序固定为「会话 → 查询」。
    /// </summary>
    internal static class VisualBridgeDebugQueryQueue
    {
        /// <summary>排队上限（附录 B.6）。</summary>
        internal const int MaxQueuedRequests = 8;

        /// <summary>并发上限：已分发但未回发结果的请求数（附录 B.6）。</summary>
        internal const int MaxConcurrentRequests = 8;

        /// <summary>排队超时（毫秒）。</summary>
        internal const int QueueTimeoutMilliseconds = 2000;

        /// <summary>执行超时（毫秒），从开始执行算起。</summary>
        internal const int ExecutionTimeoutMilliseconds = 3000;

        // 超时作废的请求号只用于识别「晚到结果」；有界保留，超出后按先进先出淘汰（防泄漏）。
        private const int MaxInvalidatedRequests = 64;

        private static readonly object Gate = new object();
        private static readonly List<VisualBridgeDebugPendingQuery> s_queue = new List<VisualBridgeDebugPendingQuery>();
        private static readonly Dictionary<uint, VisualBridgeDebugInFlightQuery> s_inFlight =
            new Dictionary<uint, VisualBridgeDebugInFlightQuery>();
        private static readonly Dictionary<uint, long> s_invalidated = new Dictionary<uint, long>();
        private static readonly Queue<uint> s_invalidatedOrder = new Queue<uint>();
        private static readonly Stopwatch s_uptime = Stopwatch.StartNew();
        private static readonly uint[] NoRequests = new uint[0];

        // 单调时钟（生产用进程运行时长，测试可注入）。会话重置不清它。
        private static Func<long> s_clock = DefaultClock;

        private static int s_pumpThreadId;
        private static bool s_pumpThreadWarned;

        private static long s_accepted;
        private static long s_dispatched;
        private static long s_completed;
        private static long s_rejected;
        private static long s_timedOutQueued;
        private static long s_timedOutExecuting;
        private static long s_busyRejected;
        private static long s_unregisteredRejected;
        private static long s_instanceNotFoundRejected;
        private static long s_invalidArgumentRejected;
        private static long s_unavailableRejected;
        private static long s_droppedLateResults;

        private static long DefaultClock()
        {
            return s_uptime.ElapsedMilliseconds;
        }

        private static long Now
        {
            get
            {
                var clock = s_clock;
                return clock == null ? DefaultClock() : clock();
            }
        }

        /// <summary>注入时钟（仅测试用；传 null 恢复单调时钟）。</summary>
        internal static void SetClock(Func<long> clock)
        {
            s_clock = clock ?? DefaultClock;
        }

        /// <summary>
        /// 校验并入队（可能来自 socket 读线程）。任何返回非 <see cref="VisualBridgeDebugQueryStatus.Accepted"/>
        /// 的结果都不会改变已有请求，调用方负责把状态翻译成失败应答。
        /// </summary>
        internal static VisualBridgeDebugQueryStatus Enqueue(VisualBridgeDebugQueryRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.InstanceId) || request.RequestSeq == 0u)
            {
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            if (request.MethodId < VisualBridgeDebugMethodIdRange.FirstCategoryMethodId)
            {
                // 0 = None、1/2 = Create/Finish、3–9 预留（附录 A.4）：查询必须指向分类方法。
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            if (!VisualBridgeDebugSession.IsAttachedAndConnected)
            {
                // 没有连接就没有可回应的通道，静默丢弃并计数（附录 B.3.1 的未连接语义）。
                return Reject(VisualBridgeDebugQueryStatus.Unavailable);
            }

            if (!VisualBridgeDebugSession.TryGetInstanceSlot(request.InstanceId, out ushort instanceSlot,
                    out string boundCategory))
            {
                return Reject(VisualBridgeDebugQueryStatus.InstanceNotFound);
            }

            if (request.InstanceSlot != 0 && request.InstanceSlot != instanceSlot)
            {
                // 二进制信封的槽位与实例 id 不一致：客户端用了过期或串线的槽位。
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            string category = string.IsNullOrEmpty(request.Category) ? boundCategory : request.Category;
            if (string.IsNullOrEmpty(category))
            {
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            if (!string.IsNullOrEmpty(boundCategory) && !string.Equals(category, boundCategory, StringComparison.Ordinal))
            {
                // 信封分类必须与实例创建时绑定的分类一致（附录 B.6.2 的"分类未知"口径）：
                // 否则可以用一个分类的处理器去查另一个分类的实例。binary 路径的槽位校验管不到分类。
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            VisualBridgeDebugRequestRegistration registration;
            if (!string.IsNullOrEmpty(request.InterfaceId))
            {
                if (!VisualBridgeDebugSession.TryGetRequestHandler(category, request.InterfaceId, out registration))
                {
                    return Reject(VisualBridgeDebugQueryStatus.Unregistered);
                }
            }
            else if (!VisualBridgeDebugSession.TryFindRequestHandler(category, request.MethodId, out registration))
            {
                // 分类内方法号唯一（附录 B.5）：找不到就说明该接口没注册处理器。
                return Reject(VisualBridgeDebugQueryStatus.Unregistered);
            }

            if (!VisualBridgeDebugRequestArguments.TryDecode(registration, request, out object[] parameters, out _))
            {
                return Reject(VisualBridgeDebugQueryStatus.InvalidArgument);
            }

            var pending = new VisualBridgeDebugPendingQuery(request, registration, parameters, instanceSlot, Now);
            VisualBridgeDebugQueryStatus status = VisualBridgeDebugQueryStatus.Accepted;
            lock (Gate)
            {
                if (s_queue.Count >= MaxQueuedRequests)
                {
                    // 队列满：立即拒绝，不挤占、不丢弃已排队的请求（附录 B.6）。
                    status = VisualBridgeDebugQueryStatus.QueueFull;
                }
                else if (s_inFlight.Count >= MaxConcurrentRequests)
                {
                    status = VisualBridgeDebugQueryStatus.ConcurrencyLimited;
                }
                else if (IsTrackedLocked(request.RequestSeq))
                {
                    // 请求号重复（同一连接内必须唯一）：按不合法拒绝，避免结果串线。
                    status = VisualBridgeDebugQueryStatus.InvalidArgument;
                }
                else
                {
                    s_queue.Add(pending);
                }
            }

            if (status != VisualBridgeDebugQueryStatus.Accepted)
            {
                return Reject(status);
            }

            Interlocked.Increment(ref s_accepted);
            return VisualBridgeDebugQueryStatus.Accepted;
        }

        /// <summary>
        /// 主线程每帧调用一次：先结算两段超时，再取最多一条执行。返回本次执行的请求数（0 或 1）。
        /// 超时应答与 handler 调用都在锁外完成。
        /// </summary>
        internal static int Pump()
        {
            NotePumpThread();

            long now = Now;
            uint[] queuedTimeouts;
            uint[] executingTimeouts;
            lock (Gate)
            {
                queuedTimeouts = TakeQueuedTimeoutsLocked(now);
                executingTimeouts = TakeExecutionTimeoutsLocked(now);
            }

            for (int index = 0; index < queuedTimeouts.Length; index++)
            {
                SendTimeout(queuedTimeouts[index], "queued");
            }

            for (int index = 0; index < executingTimeouts.Length; index++)
            {
                SendTimeout(executingTimeouts[index], "executing");
            }

            VisualBridgeDebugPendingQuery next = Dequeue();
            if (next == null)
            {
                return 0;
            }

            Dispatch(next);
            return 1;
        }

        /// <summary>
        /// 结果回发前结算句柄：超时/作废的请求返回 <see cref="VisualBridgeDebugQueryCompletion.Expired"/>，
        /// 调用方据此丢弃晚到结果并计入 dropped；在途请求成功结算为 Completed 并释放句柄。
        /// 结算后句柄进入有界的作废表，重复回发同一句柄仍会被丢弃（不产生第二次结果）。
        /// </summary>
        internal static VisualBridgeDebugQueryCompletion CompleteResult(uint requestSeq)
        {
            lock (Gate)
            {
                if (s_invalidated.ContainsKey(requestSeq))
                {
                    Interlocked.Increment(ref s_droppedLateResults);
                    return VisualBridgeDebugQueryCompletion.Expired;
                }

                if (s_inFlight.Remove(requestSeq))
                {
                    Interlocked.Increment(ref s_completed);
                    InvalidateLocked(requestSeq);
                    return VisualBridgeDebugQueryCompletion.Completed;
                }

                // 未经队列的句柄（手写处理器）：保持 D3 的宽松语义，不做归属校验。
                return VisualBridgeDebugQueryCompletion.Untracked;
            }
        }

        /// <summary>与 <see cref="CompleteResult"/> 同构：业务拒绝同样要释放句柄。</summary>
        internal static VisualBridgeDebugQueryCompletion CompleteReject(uint requestSeq)
        {
            lock (Gate)
            {
                if (s_invalidated.ContainsKey(requestSeq))
                {
                    Interlocked.Increment(ref s_droppedLateResults);
                    return VisualBridgeDebugQueryCompletion.Expired;
                }

                if (s_inFlight.Remove(requestSeq))
                {
                    Interlocked.Increment(ref s_rejected);
                    InvalidateLocked(requestSeq);
                    return VisualBridgeDebugQueryCompletion.Completed;
                }

                return VisualBridgeDebugQueryCompletion.Untracked;
            }
        }

        /// <summary>
        /// 实例已结束等原因直接作废句柄：移出在途并加入作废表（重复回发会被丢弃），
        /// 不计完成 / 拒绝（调用方计入会话 dropped）。用于「结果还没发，实例就 Finish 了」的路径。
        /// </summary>
        internal static void Discard(uint requestSeq)
        {
            lock (Gate)
            {
                s_inFlight.Remove(requestSeq);
                InvalidateLocked(requestSeq);
            }
        }

        /// <summary>会话重置（Install / Uninstall / Detach / 断连）：清空队列、在途与作废表，计数归零。</summary>
        internal static void ResetSession()
        {
            lock (Gate)
            {
                s_queue.Clear();
                s_inFlight.Clear();
                s_invalidated.Clear();
                s_invalidatedOrder.Clear();
                s_pumpThreadId = 0;
                s_pumpThreadWarned = false;
            }

            Interlocked.Exchange(ref s_accepted, 0);
            Interlocked.Exchange(ref s_dispatched, 0);
            Interlocked.Exchange(ref s_completed, 0);
            Interlocked.Exchange(ref s_rejected, 0);
            Interlocked.Exchange(ref s_timedOutQueued, 0);
            Interlocked.Exchange(ref s_timedOutExecuting, 0);
            Interlocked.Exchange(ref s_busyRejected, 0);
            Interlocked.Exchange(ref s_unregisteredRejected, 0);
            Interlocked.Exchange(ref s_instanceNotFoundRejected, 0);
            Interlocked.Exchange(ref s_invalidArgumentRejected, 0);
            Interlocked.Exchange(ref s_unavailableRejected, 0);
            Interlocked.Exchange(ref s_droppedLateResults, 0);
        }

        internal static VisualBridgeDebugQueryMetrics GetMetrics()
        {
            int queued;
            int inFlight;
            lock (Gate)
            {
                queued = s_queue.Count;
                inFlight = s_inFlight.Count;
            }

            return new VisualBridgeDebugQueryMetrics(
                queued,
                inFlight,
                Interlocked.Read(ref s_accepted),
                Interlocked.Read(ref s_dispatched),
                Interlocked.Read(ref s_completed),
                Interlocked.Read(ref s_rejected),
                Interlocked.Read(ref s_timedOutQueued),
                Interlocked.Read(ref s_timedOutExecuting),
                Interlocked.Read(ref s_busyRejected),
                Interlocked.Read(ref s_unregisteredRejected),
                Interlocked.Read(ref s_instanceNotFoundRejected),
                Interlocked.Read(ref s_invalidArgumentRejected),
                Interlocked.Read(ref s_unavailableRejected),
                Interlocked.Read(ref s_droppedLateResults));
        }

        private static void Dispatch(VisualBridgeDebugPendingQuery pending)
        {
            var request = pending.Request;

            // 排队期间实例可能被 Finish：不再调用业务实现，直接按实例不存在回应。
            if (!VisualBridgeDebugSession.IsInstanceAlive(request.InstanceId))
            {
                lock (Gate)
                {
                    InvalidateLocked(request.RequestSeq);
                }

                Interlocked.Increment(ref s_instanceNotFoundRejected);
                VisualBridgeDebugSession.SendQueryError(request.RequestSeq,
                    VisualBridgeDebugQueryErrors.InstanceNotFound, "instance finished while queued");
                return;
            }

            lock (Gate)
            {
                s_inFlight[request.RequestSeq] = new VisualBridgeDebugInFlightQuery(Now);
            }

            Interlocked.Increment(ref s_dispatched);

            bool responded;
            try
            {
                // 业务实现只在 pump 线程（主线程）执行；socket 读线程不接触 handler。
                responded = pending.Registration.Dispatcher(request.MethodId, request.InstanceId,
                    pending.InstanceSlot, request.RequestSeq, pending.Parameters);
            }
            catch (Exception exception)
            {
                // 生成代码自己 catch 并 RejectRequest；这里只兜底非生成处理器。
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 查询处理器抛出异常，按失败应答兜底：" + exception.Message);
                responded = false;
            }

            if (!responded && TryReleaseUnanswered(request.RequestSeq))
            {
                Interlocked.Increment(ref s_rejected);
                VisualBridgeDebugSession.SendReject(request.RequestSeq, "handler-returned-false");
            }
        }

        private static VisualBridgeDebugPendingQuery Dequeue()
        {
            lock (Gate)
            {
                if (s_queue.Count == 0)
                {
                    return null;
                }

                var head = s_queue[0];
                s_queue.RemoveAt(0);
                return head;
            }
        }

        /// <summary>排队超时只可能出现在队首前缀上（入队顺序即时间顺序），返回被作废的请求号。</summary>
        private static uint[] TakeQueuedTimeoutsLocked(long now)
        {
            List<uint> expired = null;
            while (s_queue.Count != 0)
            {
                var head = s_queue[0];
                if (now - head.EnqueuedAt <= QueueTimeoutMilliseconds)
                {
                    break;
                }

                s_queue.RemoveAt(0);
                InvalidateLocked(head.Request.RequestSeq);
                Interlocked.Increment(ref s_timedOutQueued);
                if (expired == null)
                {
                    expired = new List<uint>();
                }

                expired.Add(head.Request.RequestSeq);
            }

            return expired == null ? NoRequests : expired.ToArray();
        }

        /// <summary>执行超时：在途请求超过 3000 ms 就作废并回 queryTimeout（结果晚到会被丢弃）。</summary>
        private static uint[] TakeExecutionTimeoutsLocked(long now)
        {
            if (s_inFlight.Count == 0)
            {
                return NoRequests;
            }

            List<uint> expired = null;
            foreach (var pair in s_inFlight)
            {
                if (now - pair.Value.StartedAt <= ExecutionTimeoutMilliseconds)
                {
                    continue;
                }

                if (expired == null)
                {
                    expired = new List<uint>();
                }

                expired.Add(pair.Key);
            }

            if (expired == null)
            {
                return NoRequests;
            }

            for (int index = 0; index < expired.Count; index++)
            {
                s_inFlight.Remove(expired[index]);
                InvalidateLocked(expired[index]);
                Interlocked.Increment(ref s_timedOutExecuting);
            }

            return expired.ToArray();
        }

        private static void InvalidateLocked(uint requestSeq)
        {
            if (requestSeq == 0u || s_invalidated.ContainsKey(requestSeq))
            {
                return;
            }

            s_invalidated[requestSeq] = Now;
            s_invalidatedOrder.Enqueue(requestSeq);

            // 有界保留：超时请求号只用于识别晚到结果，旧的淘汰后不再追踪（防止长跑泄漏）。
            while (s_invalidated.Count > MaxInvalidatedRequests && s_invalidatedOrder.Count != 0)
            {
                s_invalidated.Remove(s_invalidatedOrder.Dequeue());
            }
        }

        private static bool IsTrackedLocked(uint requestSeq)
        {
            if (s_inFlight.ContainsKey(requestSeq) || s_invalidated.ContainsKey(requestSeq))
            {
                return true;
            }

            for (int index = 0; index < s_queue.Count; index++)
            {
                if (s_queue[index].Request.RequestSeq == requestSeq)
                {
                    return true;
                }
            }

            return false;
        }

        private static bool TryReleaseUnanswered(uint requestSeq)
        {
            lock (Gate)
            {
                return s_inFlight.Remove(requestSeq);
            }
        }

        private static void SendTimeout(uint requestSeq, string stage)
        {
            VisualBridgeDebugSession.SendQueryError(requestSeq, VisualBridgeDebugQueryErrors.Timeout,
                "stage=" + stage + "; queued=" + QueueTimeoutMilliseconds.ToString(CultureInfo.InvariantCulture)
                + "ms; executing=" + ExecutionTimeoutMilliseconds.ToString(CultureInfo.InvariantCulture) + "ms");
        }

        /// <summary>pump 必须在主线程：第一次调用记录线程，换线程时告警一次（不改变行为）。</summary>
        private static void NotePumpThread()
        {
            int threadId = Thread.CurrentThread.ManagedThreadId;
            if (s_pumpThreadId == 0)
            {
                s_pumpThreadId = threadId;
                return;
            }

            if (s_pumpThreadId == threadId || s_pumpThreadWarned)
            {
                return;
            }

            s_pumpThreadWarned = true;
            VisualBridgeDebugDiagnostics.Warning(
                "VisualBridgeDebugQueryRuntime.Pump 不在主线程调用：查询处理器必须在主线程执行（附录 B.6）。");
        }

        private static VisualBridgeDebugQueryStatus Reject(VisualBridgeDebugQueryStatus status)
        {
            switch (status)
            {
                case VisualBridgeDebugQueryStatus.QueueFull:
                case VisualBridgeDebugQueryStatus.ConcurrencyLimited:
                    Interlocked.Increment(ref s_busyRejected);
                    break;
                case VisualBridgeDebugQueryStatus.Unregistered:
                    Interlocked.Increment(ref s_unregisteredRejected);
                    break;
                case VisualBridgeDebugQueryStatus.InstanceNotFound:
                    Interlocked.Increment(ref s_instanceNotFoundRejected);
                    break;
                case VisualBridgeDebugQueryStatus.InvalidArgument:
                    Interlocked.Increment(ref s_invalidArgumentRejected);
                    break;
                case VisualBridgeDebugQueryStatus.Unavailable:
                    Interlocked.Increment(ref s_unavailableRejected);
                    break;
            }

            return status;
        }

        /// <summary>已入队、尚未分发的一条请求。</summary>
        private sealed class VisualBridgeDebugPendingQuery
        {
            internal VisualBridgeDebugPendingQuery(VisualBridgeDebugQueryRequest request,
                VisualBridgeDebugRequestRegistration registration, object[] parameters, ushort instanceSlot,
                long enqueuedAt)
            {
                Request = request;
                Registration = registration;
                Parameters = parameters;
                InstanceSlot = instanceSlot;
                EnqueuedAt = enqueuedAt;
            }

            internal VisualBridgeDebugQueryRequest Request { get; }

            internal VisualBridgeDebugRequestRegistration Registration { get; }

            internal object[] Parameters { get; }

            /// <summary>由实例 id 反查到的槽位（JSON 信封没有 instanceSlot，二进制信封可能为 0）。</summary>
            internal ushort InstanceSlot { get; }

            internal long EnqueuedAt { get; }
        }

        /// <summary>已分发、尚未回发结果的请求。</summary>
        private sealed class VisualBridgeDebugInFlightQuery
        {
            internal VisualBridgeDebugInFlightQuery(long startedAt)
            {
                StartedAt = startedAt;
            }

            internal long StartedAt { get; }
        }
    }

    /// <summary>句柄结算结果：Untracked = 不是队列里的请求（手写处理器），Completed = 正常结算，Expired = 已超时作废。</summary>
    internal enum VisualBridgeDebugQueryCompletion
    {
        Untracked = 0,
        Completed = 1,
        Expired = 2,
    }
#endif
}
