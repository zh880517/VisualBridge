using System;
using UnityEditor;

namespace VisualBridge.Editor
{
    /// <summary>
    /// Editor 模式统一连接的会话身份（附录 A.3/A.8）。Domain Reload 会销毁托管状态与套接字，
    /// 但 <see cref="SessionState"/> 在进程内保留，因此这里持久化重连续接所需的四项事实：
    /// <list type="bullet">
    /// <item><description><c>sessionId</c>（<c>endpointId#bootId</c>）：重连时作为 hello 的
    /// <c>resumeSessionId</c> 发回，服务端据此返回 <c>resumed</c>。它跨 Domain Reload 稳定，
    /// 而 <c>generation</c> 每次传输 +1 且不参与 <c>sessionId</c>，故不需要持久化。</description></item>
    /// <item><description><c>recordPath</c>：上次连接窗口的发现记录路径，重连时优先复核该窗口，
    /// 记录陈旧/失配再退回枚举（附录 A.7）。</description></item>
    /// <item><description><c>debugEnabled</c>：welcome 通告的 debug 总开关当前值，调试面
    /// （E5/G1）消费；本任务只负责保存与恢复。</description></item>
    /// <item><description><c>lastSeenUtc</c>：最近一次确认连接可用的时刻（ISO 8601 round-trip，
    /// 存入 SessionState）。Domain Reload 时托管代码来不及记录"断开时刻"，所以用最后存活时刻
    /// 作为宽限判定的起点；连接建立后由 <see cref="VisualBridgeEditorBridgeAutoConnect"/> 周期刷新，
    /// 使"长会话后 reload"仍落在 <see cref="ReconnectGraceMs"/> 内。超过宽限即视为新会话
    /// （附录 A.8 的 <c>ReconnectGraceMs</c>）。</description></item>
    /// </list>
    /// 读写可能发生在后台线程（Bridge 窗口用线程池发请求），而 SessionState 只在主线程可用：
    /// 读失败按"无会话"处理，写失败静默——会话续接是优化项，不能因为持久化失败阻断本次连接。
    /// </summary>
    public sealed class VisualBridgeSessionState
    {
        /// <summary>会话宽限期（附录 A.8 的 <c>ReconnectGraceMs</c>）：超过即不再续接。</summary>
        public const int ReconnectGraceMs = 15000;

        /// <summary>会话 id 的 SessionState 键（endpointId#bootId）。</summary>
        public const string SessionIdKey = "VisualBridge.Bridge.SessionId";

        /// <summary>发现记录路径的 SessionState 键。</summary>
        public const string RecordPathKey = "VisualBridge.Bridge.RecordPath";

        /// <summary>debug 总开关当前值的 SessionState 键（"1"/"0"）。</summary>
        public const string DebugEnabledKey = "VisualBridge.Bridge.DebugEnabled";

        /// <summary>最近存活时刻的 SessionState 键（ISO 8601 round-trip，UTC）。</summary>
        public const string LastSeenUtcKey = "VisualBridge.Bridge.LastSeenUtc";

        /// <summary>E2 时代的旧键；只读回退，升级期间不丢已有会话。</summary>
        private const string LegacySessionIdKey = "VisualBridge.EditorBridge.ResumeSessionId";

        private const string TrueText = "1";
        private const string FalseText = "0";

        /// <summary>ISO 8601 round-trip 格式：带 UTC 设计符，跨 reload 与区域设置稳定。</summary>
        private const string UtcFormat = "o";

        private readonly string sessionId;
        private readonly string recordPath;
        private readonly bool debugEnabled;
        private readonly DateTime? lastSeenUtc;

        private VisualBridgeSessionState(string sessionId, string recordPath, bool debugEnabled, DateTime? lastSeenUtc)
        {
            this.sessionId = string.IsNullOrEmpty(sessionId) ? string.Empty : sessionId;
            this.recordPath = string.IsNullOrEmpty(recordPath) ? string.Empty : recordPath;
            this.debugEnabled = debugEnabled;
            this.lastSeenUtc = lastSeenUtc.HasValue ? lastSeenUtc.Value.ToUniversalTime() : (DateTime?)null;
        }

        /// <summary>没有任何已持久化会话时的空状态。</summary>
        public static VisualBridgeSessionState Empty { get; } = new VisualBridgeSessionState(null, null, false, null);

        /// <summary><c>endpointId#bootId</c>；没有会话时为空串。</summary>
        public string SessionId => sessionId;

        /// <summary>上次连接窗口的发现记录路径；没有会话时为空串。</summary>
        public string RecordPath => recordPath;

        /// <summary>服务端 welcome 通告的 debug 总开关当前值。</summary>
        public bool DebugEnabled => debugEnabled;

        /// <summary>最近一次确认连接可用的 UTC 时刻；从未连接时为 null。</summary>
        public DateTime? LastSeenUtc => lastSeenUtc;

        /// <summary>是否存在可续接的会话 id。</summary>
        public bool HasSession => sessionId.Length > 0;

        /// <summary>
        /// 宽限期是否已过：有会话但没有存活时刻记录，或距最后存活时刻超过
        /// <see cref="ReconnectGraceMs"/> 即视为不可续接（附录 A.8）。
        /// </summary>
        public bool IsReconnectGraceExpired(DateTime utcNow)
        {
            if (!HasSession)
            {
                return false;
            }

            if (!lastSeenUtc.HasValue)
            {
                return true;
            }

            return utcNow.ToUniversalTime() - lastSeenUtc.Value > TimeSpan.FromMilliseconds(ReconnectGraceMs);
        }

        /// <summary>
        /// 返回一次连接完成后的新状态；不修改当前实例（状态是不可变快照）。
        /// <paramref name="utcNow"/> 缺省取当前 UTC，测试可注入假时刻。
        /// </summary>
        public VisualBridgeSessionState WithConnection(
            string connectedSessionId, string connectedRecordPath, bool connectedDebugEnabled, DateTime? utcNow = null)
        {
            return new VisualBridgeSessionState(
                connectedSessionId, connectedRecordPath, connectedDebugEnabled, utcNow ?? DateTime.UtcNow);
        }

        /// <summary>返回只更新最后存活时刻的新状态（连接仍在时由主线程周期刷新）。</summary>
        public VisualBridgeSessionState WithLastSeen(DateTime utcNow)
        {
            return new VisualBridgeSessionState(sessionId, recordPath, debugEnabled, utcNow);
        }

        /// <summary>写入 SessionState；SessionState 在主线程之外不可用时静默失败。</summary>
        public void Save()
        {
            try
            {
                SessionState.SetString(SessionIdKey, sessionId);
                SessionState.SetString(RecordPathKey, recordPath);
                SessionState.SetString(DebugEnabledKey, debugEnabled ? TrueText : FalseText);
                if (lastSeenUtc.HasValue)
                {
                    SessionState.SetString(
                        LastSeenUtcKey, lastSeenUtc.Value.ToString(UtcFormat, System.Globalization.CultureInfo.InvariantCulture));
                }
                else
                {
                    SessionState.EraseString(LastSeenUtcKey);
                }

                // 迁移完成：旧键不再读写，避免出现两个会话身份来源。
                SessionState.EraseString(LegacySessionIdKey);
            }
            catch (Exception)
            {
                // 后台线程或 SessionState 不可用：续接是优化项，不阻断本次连接。
            }
        }

        /// <summary>从 SessionState 恢复；任一项缺失都按缺省值处理。</summary>
        public static VisualBridgeSessionState Load()
        {
            try
            {
                var storedSessionId = SessionState.GetString(SessionIdKey, string.Empty);
                if (string.IsNullOrEmpty(storedSessionId))
                {
                    storedSessionId = SessionState.GetString(LegacySessionIdKey, string.Empty);
                }

                var storedRecordPath = SessionState.GetString(RecordPathKey, string.Empty);
                var storedDebugEnabled = SessionState.GetString(DebugEnabledKey, string.Empty);
                var storedLastSeen = SessionState.GetString(LastSeenUtcKey, string.Empty);
                DateTime parsedLastSeen;
                DateTime? lastSeen = null;
                if (!string.IsNullOrEmpty(storedLastSeen)
                    && DateTime.TryParse(
                        storedLastSeen,
                        System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out parsedLastSeen))
                {
                    lastSeen = parsedLastSeen;
                }

                return new VisualBridgeSessionState(
                    storedSessionId,
                    storedRecordPath,
                    string.Equals(storedDebugEnabled, TrueText, StringComparison.Ordinal),
                    lastSeen);
            }
            catch (Exception)
            {
                return Empty;
            }
        }

        /// <summary>丢弃已持久化的会话（下一次连接从全新会话开始）。</summary>
        public static void Clear()
        {
            try
            {
                SessionState.EraseString(SessionIdKey);
                SessionState.EraseString(RecordPathKey);
                SessionState.EraseString(DebugEnabledKey);
                SessionState.EraseString(LastSeenUtcKey);
                SessionState.EraseString(LegacySessionIdKey);
            }
            catch (Exception)
            {
                // 同 Save：持久化不可用时没有需要清理的状态。
            }
        }
    }
}
