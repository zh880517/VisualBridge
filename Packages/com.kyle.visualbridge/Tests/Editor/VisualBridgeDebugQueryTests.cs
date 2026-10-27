using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// D4 反向查询（附录 B.6）的 EditMode 用例：分发、回发、未注册、实例不存在、两段超时、
    /// 请求与结果关联（并发不串结果）、队列满 / 并发上限、晚到结果丢弃与计数、handler 运行在主线程。
    /// 生成的 Dispatcher 用测试内的等价实现代替（同一签名、同样用 7 参句柄携带归属）。
    /// </summary>
    public sealed class VisualBridgeDebugQueryTests
    {
        private const string Category = "query";
        private const string InterfaceId = "IVisualBridgeTestQueryDebuger";
        private const string InstanceId = "inst-1";
        private const ushort IsVisibleMethodId = 10;
        private const ushort ResetMethodId = 11;

        private long _now;
        private FakeTransport _transport;

        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugDiagnostics.Reset();

            _now = 0;
            VisualBridgeDebugQueryQueue.SetClock(() => _now);

            TestDispatcher.Handler = DefaultHandler;
            TestDispatcher.Calls = 0;

            _transport = new FakeTransport();
            VisualBridgeDebugBridge.Install(_transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "res", ""), Is.True);
            _transport.Creates.Clear();

            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId,
                new VisualBridgeDebugRequestDispatcher(TestDispatcher.Dispatch),
                new VisualBridgeDebugRequestParameterDecoder(TestDispatcher.TryGetParameters));
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugQueryQueue.SetClock(null);
            TestDispatcher.Handler = null;
        }

        [Test]
        public void PumpDispatchesOnMainThreadAndSendsTheAttributedResult()
        {
            var mainThreadId = Thread.CurrentThread.ManagedThreadId;
            int handlerThreadId = 0;
            object[] observedParameters = null;
            var observedRequest = default(VisualBridgeDebugRequest);
            TestDispatcher.Handler = (request, parameters) =>
            {
                handlerThreadId = Thread.CurrentThread.ManagedThreadId;
                observedParameters = parameters;
                observedRequest = request;
                return SendIsVisibleResult(request, true);
            };

            // 入队发生在 socket 读线程（这里用后台线程模拟）：读线程不调用 handler。
            Assert.That(EnqueueFromBackground(Request(7, nodeId: 3)), Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(handlerThreadId, Is.EqualTo(0), "pump 之前不得执行 handler");
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().QueuedCount, Is.EqualTo(1));

            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(handlerThreadId, Is.EqualTo(mainThreadId), "handler 必须在主线程执行");

            Assert.That(observedParameters.Length, Is.EqualTo(1), "业务参数里不能混入 requestId");
            Assert.That((int)observedParameters[0], Is.EqualTo(3));
            Assert.That(observedRequest.InstanceId, Is.EqualTo(InstanceId));
            Assert.That(
                typeof(VisualBridgeDebugRequest).GetProperties().Length,
                Is.EqualTo(1),
                "RequestId 只在信封里，句柄只公开 InstanceId（附录 B.6）");

            var json = ParseResult(_transport.Results[0]);
            Assert.That((string)json["type"], Is.EqualTo("debugResult"));
            Assert.That((string)json["requestId"], Is.EqualTo("req-7"));
            Assert.That((string)json["category"], Is.EqualTo(Category));
            Assert.That((string)json["instance"], Is.EqualTo(InstanceId));
            Assert.That((string)json["iface"], Is.EqualTo(InterfaceId), "7 参句柄直接携带归属，运行期不反射");
            Assert.That((string)json["method"], Is.EqualTo("IsVisible"));

            var metrics = VisualBridgeDebugQueryRuntime.GetMetrics();
            Assert.That(metrics.CompletedCount, Is.EqualTo(1));
            Assert.That(metrics.InFlightCount, Is.EqualTo(0));
        }

        [Test]
        public void BinaryRequestWithoutInterfaceResolvesTheHandlerByMethodId()
        {
            // 二进制信封没有 iface：按分类内方法号唯一性反查处理器（不反射生成成员）。
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, interfaceId: null));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(1));
            Assert.That(_transport.Results.Count, Is.EqualTo(1));
            Assert.That((string)ParseResult(_transport.Results[0])["iface"], Is.EqualTo(InterfaceId));
        }

        [Test]
        public void UnregisteredInterfaceIsRejectedWithQueryUnregistered()
        {
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, interfaceId: "IMissingDebuger"));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.Unregistered));
            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(1));
            Assert.That(_transport.QueryErrors[0].RequestSeq, Is.EqualTo(1u));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.queryUnregistered"));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().UnregisteredRejectedCount, Is.EqualTo(1));
        }

        [Test]
        public void UnknownMethodIdIsRejectedAsInvalidArgument()
        {
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, methodId: 99));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.invalidArgument"));
        }

        [Test]
        public void RequestWithoutACategoryMethodIdIsRejectedAsInvalidArgument()
        {
            // 0 = None、1/2 = Create/Finish、3–9 预留（A.4）：直接调 API 也按不合法拒绝。
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, methodId: 0));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.invalidArgument"));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0));
        }

        [Test]
        public void RequestCategoryMustMatchTheInstanceBinding()
        {
            // 信封的分类与实例创建时绑定的分类不一致（B.6.2 的"分类未知"）：不得跨分类取处理器。
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, category: "visualbridge.entity"));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.invalidArgument"));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(0));
        }

        [Test]
        public void UnknownTagOrWrongValueTypeIsRejectedAsInvalidArgument()
        {
            var unknownTag = new VisualBridgeDebugQueryRequest(1, Category, InstanceId, IsVisibleMethodId, InterfaceId,
                "IsVisible", new[] { new VisualBridgeDebugQueryArgument(5, "nodeId", 1) });
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(unknownTag),
                Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));

            var wrongType = new VisualBridgeDebugQueryRequest(2, Category, InstanceId, IsVisibleMethodId, InterfaceId,
                "IsVisible", new[] { new VisualBridgeDebugQueryArgument(1, "nodeId", "not-an-int") });
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(wrongType),
                Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));
            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(2));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InvalidArgumentRejectedCount, Is.EqualTo(2));
        }

        [Test]
        public void MissingInstanceIsRejectedAsInstanceNotFound()
        {
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, instanceId: "ghost"));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.InstanceNotFound));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.instanceNotFound"));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InstanceNotFoundRejectedCount, Is.EqualTo(1));
        }

        [Test]
        public void SlotMismatchWithTheInstanceIsRejectedAsInvalidArgument()
        {
            var status = VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1, instanceSlot: 42));
            Assert.That(status, Is.EqualTo(VisualBridgeDebugQueryStatus.InvalidArgument));
        }

        [Test]
        public void FullQueueRejectsImmediatelyWithoutTouchingExistingRequests()
        {
            TestDispatcher.Handler = DeferredHandler;

            for (uint index = 1; index <= VisualBridgeDebugQueryRuntime.MaxQueuedRequests; index++)
            {
                Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(index)),
                    Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            }

            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().QueuedCount, Is.EqualTo(8));
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(9)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.QueueFull));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.queryBusy"));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().QueuedCount, Is.EqualTo(8),
                "队列满不得丢弃已有请求");
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().BusyRejectedCount, Is.EqualTo(1));

            // 已排队的 8 条照常执行。
            for (int index = 0; index < 8; index++)
            {
                Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            }

            Assert.That(TestDispatcher.Calls, Is.EqualTo(8));
        }

        [Test]
        public void ConcurrencyLimitRejectsWhenEightRequestsAreInFlight()
        {
            TestDispatcher.Handler = DeferredHandler;

            for (uint index = 1; index <= VisualBridgeDebugQueryRuntime.MaxConcurrentRequests; index++)
            {
                Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(index)),
                    Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
                Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            }

            var metrics = VisualBridgeDebugQueryRuntime.GetMetrics();
            Assert.That(metrics.InFlightCount, Is.EqualTo(8));
            Assert.That(metrics.QueuedCount, Is.EqualTo(0));

            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(9)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.ConcurrencyLimited));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.queryBusy"));
        }

        [Test]
        public void QueuedTimeoutFiresAtTwoSecondsAndNeverRunsTheHandler()
        {
            _now = 0;
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));

            _now = VisualBridgeDebugQueryRuntime.QueueTimeoutMilliseconds + 1;
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0), "超时的排队请求不再执行");

            Assert.That(TestDispatcher.Calls, Is.EqualTo(0));
            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(1));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.queryTimeout"));
            var metrics = VisualBridgeDebugQueryRuntime.GetMetrics();
            Assert.That(metrics.TimedOutQueuedCount, Is.EqualTo(1));
            Assert.That(metrics.QueuedCount, Is.EqualTo(0));
        }

        [Test]
        public void ExecutionTimeoutInvalidatesTheHandleAndDropsTheLateResult()
        {
            var deferred = new List<VisualBridgeDebugRequest>();
            TestDispatcher.Handler = (request, parameters) =>
            {
                deferred.Add(request);
                return true;
            };

            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(5)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(1));

            _now = VisualBridgeDebugQueryRuntime.ExecutionTimeoutMilliseconds + 1;
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0), "超时的在途请求被作废");

            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(1));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.queryTimeout"));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().TimedOutExecutingCount, Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(0));

            // 晚到结果：StartResult 返回 false、不产生消息、计入 dropped（同时释放句柄）。
            var droppedBefore = VisualBridgeDebugMetrics.GetSnapshot().DroppedMessages;
            Assert.That(SendIsVisibleResult(deferred[0], true), Is.False);
            Assert.That(_transport.Results.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugMetrics.GetSnapshot().DroppedMessages, Is.EqualTo(droppedBefore + 1));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().DroppedLateResultCount, Is.EqualTo(1));

            // 句柄已释放：重复晚到仍然被丢弃，不产生第二条消息。
            Assert.That(SendIsVisibleResult(deferred[0], true), Is.False);
            Assert.That(_transport.Results.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().DroppedLateResultCount, Is.EqualTo(2));
        }

        [Test]
        public void FinishedInstanceMakesStartResultReturnFalse()
        {
            TestDispatcher.Handler = (request, parameters) =>
            {
                Assert.That(VisualBridgeDebug.Finish(InstanceId), Is.True);
                return SendIsVisibleResult(request, true);
            };

            var droppedBefore = VisualBridgeDebugMetrics.GetSnapshot().DroppedMessages;
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));

            Assert.That(_transport.Results.Count, Is.EqualTo(0), "实例已结束，结果不得发出");
            Assert.That(VisualBridgeDebugMetrics.GetSnapshot().DroppedMessages, Is.EqualTo(droppedBefore + 1));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(0),
                "实例结束路径同样要释放句柄");
        }

        [Test]
        public void ConcurrentRequestsOnTheSameMethodDoNotCrossResults()
        {
            var deferred = new List<(VisualBridgeDebugRequest Request, object[] Parameters)>();
            TestDispatcher.Handler = (request, parameters) =>
            {
                deferred.Add((request, parameters));
                return true;
            };

            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(11, nodeId: 1)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(12, nodeId: 2)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(deferred.Count, Is.EqualTo(2));

            // 逆序回发：结果必须按句柄关联，不能串。
            Assert.That(SendIsVisibleResult(deferred[1].Request, true), Is.True);
            Assert.That(SendIsVisibleResult(deferred[0].Request, false), Is.True);

            Assert.That(_transport.Results.Count, Is.EqualTo(2));
            Assert.That(_transport.Results[0].RequestSeq, Is.EqualTo(12u));
            Assert.That(_transport.Results[1].RequestSeq, Is.EqualTo(11u));

            var second = ParseResult(_transport.Results[0]);
            var first = ParseResult(_transport.Results[1]);
            Assert.That((string)second["requestId"], Is.EqualTo("req-12"));
            Assert.That((string)first["requestId"], Is.EqualTo("req-11"));
            Assert.That((bool)second["args"][0]["value"], Is.True);
            // false 是 bool 的默认值，按附录 A.4 不写进载荷：这与「结果挂到了哪个请求」无关。
            Assert.That(first["args"] == null || !first["args"].Any(), Is.True);
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().CompletedCount, Is.EqualTo(2));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(0));
        }

        [Test]
        public void RejectRequestSendsFailureResponseAndReleasesTheHandle()
        {
            var deferred = new List<VisualBridgeDebugRequest>();
            TestDispatcher.Handler = (request, parameters) =>
            {
                deferred.Add(request);
                return VisualBridgeDebug.RejectRequest(request, "not-now");
            };

            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(4)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));

            Assert.That(_transport.Rejects.Count, Is.EqualTo(1), "RejectRequest 必须走失败应答而不是静默丢弃");
            Assert.That(_transport.Rejects[0].RequestSeq, Is.EqualTo(4u));
            Assert.That(_transport.Rejects[0].Reason, Is.EqualTo("not-now"));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().RejectedCount, Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(0));

            // 拒绝之后同一个句柄再发结果会被当作晚到消息丢弃。
            Assert.That(SendIsVisibleResult(deferred[0], true), Is.False);
            Assert.That(_transport.Results.Count, Is.EqualTo(0));
        }

        [Test]
        public void HandlerReturningFalseWithoutResponseGetsAFailureResponse()
        {
            TestDispatcher.Handler = (request, parameters) => false;

            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(8)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));

            Assert.That(_transport.Rejects.Count, Is.EqualTo(1), "未应答的 handler 不能留下悬挂句柄");
            Assert.That(_transport.Rejects[0].RequestSeq, Is.EqualTo(8u));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InFlightCount, Is.EqualTo(0));
        }

        [Test]
        public void PumpExecutesAtMostOneRequestPerCall()
        {
            TestDispatcher.Handler = DeferredHandler;
            for (uint index = 1; index <= 3; index++)
            {
                Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(index)),
                    Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            }

            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(3));
        }

        [Test]
        public void InstanceFinishedWhileQueuedIsAnsweredOnDispatch()
        {
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebug.Finish(InstanceId), Is.True);

            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1));
            Assert.That(TestDispatcher.Calls, Is.EqualTo(0), "实例已结束就不再调用业务实现");
            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(1));
            Assert.That(_transport.QueryErrors[0].Code, Is.EqualTo("runtime.instanceNotFound"));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().InstanceNotFoundRejectedCount,
                Is.EqualTo(1));
        }

        [Test]
        public void DisconnectedSessionDropsRequestsSilentlyAndResetsMetrics()
        {
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(1)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Accepted));
            Assert.That(VisualBridgeDebugQueryRuntime.GetMetrics().QueuedCount, Is.EqualTo(1));

            VisualBridgeDebugBridge.Uninstall();
            var metrics = VisualBridgeDebugQueryRuntime.GetMetrics();
            Assert.That(metrics.QueuedCount, Is.EqualTo(0), "会话重置要清空查询队列");
            Assert.That(metrics.AcceptedCount, Is.EqualTo(0), "计数随会话重置归零");

            // 未挂接时没有可回应的通道：静默丢弃、不产生错误应答。
            Assert.That(VisualBridgeDebugQueryRuntime.TryEnqueue(Request(2)),
                Is.EqualTo(VisualBridgeDebugQueryStatus.Unavailable));
            Assert.That(_transport.QueryErrors.Count, Is.EqualTo(0));
        }

        private static bool DefaultHandler(VisualBridgeDebugRequest request, object[] parameters)
        {
            return SendIsVisibleResult(request, (int)parameters[0] > 0);
        }

        private static bool DeferredHandler(VisualBridgeDebugRequest request, object[] parameters)
        {
            return true;
        }

        private static bool SendIsVisibleResult(VisualBridgeDebugRequest request, bool visible)
        {
            if (!VisualBridgeDebug.StartResult(request))
            {
                return false;
            }

            VisualBridgeDebug.PushParam("visible", 1, visible);
            return VisualBridgeDebug.End();
        }

        private static VisualBridgeDebugQueryRequest Request(uint requestSeq, ushort methodId = IsVisibleMethodId,
            string interfaceId = InterfaceId, string instanceId = InstanceId, ushort instanceSlot = 0, int nodeId = 1,
            string category = Category)
        {
            return new VisualBridgeDebugQueryRequest(requestSeq, category, instanceId, instanceSlot, methodId,
                interfaceId, "IsVisible", new[] { new VisualBridgeDebugQueryArgument(1, "nodeId", nodeId) });
        }

        /// <summary>模拟 socket 读线程入队：返回状态并与主线程解耦。</summary>
        private static VisualBridgeDebugQueryStatus EnqueueFromBackground(VisualBridgeDebugQueryRequest request)
        {
            var status = VisualBridgeDebugQueryStatus.Unavailable;
            var thread = new Thread(() => { status = VisualBridgeDebugQueryRuntime.TryEnqueue(request); });
            thread.Start();
            thread.Join();
            return status;
        }

        private static JObject ParseResult((uint RequestSeq, VisualBridgeDebugEncodedMessage Message) result)
        {
            return JObject.Parse(Encoding.UTF8.GetString(result.Message.Payload.ToArray()));
        }

        /// <summary>测试内等价于生成 Dispatcher 的分发器：同一签名，同样用 7 参句柄携带归属。</summary>
        private static class TestDispatcher
        {
            internal static Func<VisualBridgeDebugRequest, object[], bool> Handler;

            internal static int Calls;

            internal static bool Dispatch(ushort methodId, string instanceId, ushort instanceSlot, uint requestSeq,
                object[] parameters)
            {
                switch (methodId)
                {
                    case IsVisibleMethodId:
                        return Run(CreateRequest(instanceId, instanceSlot, methodId, requestSeq, "IsVisible"),
                            parameters);
                    case ResetMethodId:
                        return Run(CreateRequest(instanceId, instanceSlot, methodId, requestSeq, "Reset"), parameters);
                    default:
                        return false;
                }
            }

            internal static bool TryGetParameters(ushort methodId, out string[] names, out ushort[] tags,
                out Type[] types)
            {
                switch (methodId)
                {
                    case IsVisibleMethodId:
                        names = new[] { "nodeId" };
                        tags = new[] { (ushort)1 };
                        types = new[] { typeof(int) };
                        return true;
                    case ResetMethodId:
                        names = new string[0];
                        tags = new ushort[0];
                        types = new Type[0];
                        return true;
                    default:
                        names = null;
                        tags = null;
                        types = null;
                        return false;
                }
            }

            private static bool Run(VisualBridgeDebugRequest request, object[] parameters)
            {
                Calls++;
                return Handler != null && Handler(request, parameters);
            }

            private static VisualBridgeDebugRequest CreateRequest(string instanceId, ushort instanceSlot,
                ushort methodId, uint requestSeq, string method)
            {
                return new VisualBridgeDebugRequest(instanceId, instanceSlot, methodId, requestSeq,
                    Category, InterfaceId, method);
            }
        }

        /// <summary>假传输：记录结果 / 失败应答 / 控制消息；连接态固定为已连接。</summary>
        private sealed class FakeTransport : IVisualBridgeDebugTransport
        {
            public bool IsConnected
            {
                get { return true; }
            }

            public ConnectType ConnectType
            {
                get { return VisualBridge.Diagnostics.ConnectType.Editor; }
            }

            public long ConnectionGeneration
            {
                get { return 1L; }
            }

            public List<(string InstanceId, string Category, string ResName, string DebugInfo, ushort Slot)> Creates
            {
                get;
            } = new List<(string, string, string, string, ushort)>();

            public List<(uint RequestSeq, VisualBridgeDebugEncodedMessage Message)> Results
            {
                get;
            } = new List<(uint, VisualBridgeDebugEncodedMessage)>();

            public List<(uint RequestSeq, string Reason)> Rejects { get; } = new List<(uint, string)>();

            public List<(uint RequestSeq, string Code, string Detail)> QueryErrors
            {
                get;
            } = new List<(uint, string, string)>();

            public List<VisualBridgeDebugEncodedMessage> Controls { get; } =
                new List<VisualBridgeDebugEncodedMessage>();

            public bool SendCreate(string instanceId, string category, string resName, string debugInfo,
                ushort instanceSlot)
            {
                Creates.Add((instanceId, category, resName, debugInfo, instanceSlot));
                return true;
            }

            public bool SendFinish(string instanceId, ushort instanceSlot)
            {
                return true;
            }

            public bool SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
                long frame, VisualBridgeDebugEncodedMessage message)
            {
                return true;
            }

            public bool SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message)
            {
                Results.Add((requestSeq, message));
                return true;
            }

            public bool SendControl(VisualBridgeDebugEncodedMessage message)
            {
                Controls.Add(message);
                return true;
            }

            public bool SendReject(uint requestSeq, string reason)
            {
                Rejects.Add((requestSeq, reason));
                return true;
            }

            public bool SendQueryError(uint requestSeq, string code, string detail)
            {
                QueryErrors.Add((requestSeq, code, detail));
                return true;
            }
        }
    }
}
