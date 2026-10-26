using System;
using System.Collections.Generic;
using System.Text;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// 发送队列与单写序列的 EditMode 用例：单调序号、控制消息屏障、
    /// 数据队列淘汰最旧、控制队列满则断开、超长消息入队前拒绝。
    /// </summary>
    public sealed class VisualBridgeSendQueueTests
    {
        [Test]
        public void SingleMonotonicSequenceSpansBothChannels()
        {
            var queues = new VisualBridgeSendQueues();
            Assert.That(queues.TryEnqueueDebug(Bytes("d1"), out var first, VisualBridgePayloadKind.Json), Is.EqualTo(VisualBridgeEnqueueStatus.Ok));
            Assert.That(queues.TryEnqueueControl(Bytes("c1"), out var second), Is.EqualTo(VisualBridgeEnqueueStatus.Ok));
            Assert.That(queues.TryEnqueueDebug(Bytes("d2"), out var third, VisualBridgePayloadKind.Binary), Is.EqualTo(VisualBridgeEnqueueStatus.Ok));

            Assert.That(first, Is.EqualTo(1));
            Assert.That(second, Is.EqualTo(2));
            Assert.That(third, Is.EqualTo(3));

            var messages = Drain(queues);
            Assert.That(messages.Count, Is.EqualTo(3));
            Assert.That(messages[0].Sequence, Is.EqualTo(1));
            Assert.That(messages[1].Sequence, Is.EqualTo(2));
            Assert.That(messages[2].Sequence, Is.EqualTo(3));
            Assert.That(queues.SnapshotCounters().RejectedTooLarge, Is.Zero);
        }

        [Test]
        public void ControlBarrierKeepsQueuedDataFramesAheadOfFinish()
        {
            var queues = new VisualBridgeSendQueues();
            queues.TryEnqueueDebug(Bytes("frame-1"), out var data1, VisualBridgePayloadKind.Binary);
            queues.TryEnqueueDebug(Bytes("frame-2"), out var data2, VisualBridgePayloadKind.Binary);
            queues.TryEnqueueControl(Bytes("{\"type\":\"Finish\"}"), out var finish);
            queues.TryEnqueueDebug(Bytes("frame-3"), out var data3, VisualBridgePayloadKind.Binary);

            var messages = Drain(queues);
            Assert.That(messages.Count, Is.EqualTo(4));
            Assert.That(messages[0].Sequence, Is.EqualTo(data1));
            Assert.That(messages[1].Sequence, Is.EqualTo(data2));
            Assert.That(messages[2].Sequence, Is.EqualTo(finish));
            Assert.That(messages[2].Channel, Is.EqualTo(VisualBridgeChannel.Editor));
            Assert.That(messages[2].Barrier, Is.EqualTo(data2));
            Assert.That(messages[3].Sequence, Is.EqualTo(data3));
        }

        [Test]
        public void ControlMessagesBeforeLaterDataFramesStillRespectTheirBarrier()
        {
            var queues = new VisualBridgeSendQueues();
            queues.TryEnqueueControl(Bytes("{\"type\":\"Finish\"}"), out var finish);
            queues.TryEnqueueDebug(Bytes("frame-1"), out var data1, VisualBridgePayloadKind.Binary);
            queues.TryEnqueueControl(Bytes("{\"type\":\"debugFinish\"}"), out var finish2);

            var messages = Drain(queues);
            Assert.That(messages.Count, Is.EqualTo(3));
            Assert.That(messages[0].Sequence, Is.EqualTo(finish));
            Assert.That(messages[1].Sequence, Is.EqualTo(data1));
            Assert.That(messages[2].Sequence, Is.EqualTo(finish2));
            Assert.That(messages[2].Barrier, Is.EqualTo(data1));
        }

        [Test]
        public void DataQueueDropsOldestDataMessagesWhenMessageCapIsReached()
        {
            var queues = new VisualBridgeSendQueues(new VisualBridgeSendLimits { DataCapacityMessages = 4 });
            for (var index = 0; index < 6; index++)
            {
                Assert.That(
                    queues.TryEnqueueDebug(Bytes("d" + index), out _, VisualBridgePayloadKind.Json),
                    Is.EqualTo(VisualBridgeEnqueueStatus.Ok));
            }

            Assert.That(queues.DataPendingCount, Is.EqualTo(4));
            var counters = queues.SnapshotCounters();
            Assert.That(counters.DebugDroppedMessages, Is.EqualTo(2));
            Assert.That(counters.DebugEnqueued, Is.EqualTo(6));

            var messages = Drain(queues);
            Assert.That(messages.Count, Is.EqualTo(4));
            Assert.That(Text(messages[0]), Is.EqualTo("d2"));
            Assert.That(Text(messages[3]), Is.EqualTo("d5"));
        }

        [Test]
        public void DataQueueDropsOldestDataMessagesWhenByteCapIsReached()
        {
            var queues = new VisualBridgeSendQueues(new VisualBridgeSendLimits { DataCapacityBytes = 10 });
            queues.TryEnqueueDebug(new byte[4], out _, VisualBridgePayloadKind.Binary);
            queues.TryEnqueueDebug(new byte[4], out _, VisualBridgePayloadKind.Binary);
            queues.TryEnqueueDebug(new byte[4], out _, VisualBridgePayloadKind.Binary);

            Assert.That(queues.DataPendingBytes, Is.EqualTo(8));
            Assert.That(queues.SnapshotCounters().DebugDroppedMessages, Is.EqualTo(1));
            Assert.That(queues.SnapshotCounters().DebugDroppedBytes, Is.EqualTo(4));
        }

        [Test]
        public void ControlQueueNeverEvictsAndReportsFullAtCapacity()
        {
            var queues = new VisualBridgeSendQueues();
            for (var index = 0; index < 256; index++)
            {
                Assert.That(
                    queues.TryEnqueueControl(Bytes("c" + index), out _),
                    Is.EqualTo(VisualBridgeEnqueueStatus.Ok),
                    "control " + index);
            }

            Assert.That(queues.ControlPendingCount, Is.EqualTo(256));
            Assert.That(
                queues.TryEnqueueControl(Bytes("c-overflow"), out _),
                Is.EqualTo(VisualBridgeEnqueueStatus.ControlQueueFull));
            Assert.That(queues.ControlPendingCount, Is.EqualTo(256), "满队列不得淘汰控制消息");

            var messages = Drain(queues);
            Assert.That(messages.Count, Is.EqualTo(256));
            Assert.That(Text(messages[0]), Is.EqualTo("c0"));
            Assert.That(Text(messages[255]), Is.EqualTo("c255"));
            Assert.That(queues.SnapshotCounters().WrittenControl, Is.EqualTo(256));
        }

        [Test]
        public void OversizedMessageIsRejectedBeforeEnqueueAndCounted()
        {
            var queues = new VisualBridgeSendQueues();
            var oversized = new byte[VisualBridgeFraming.MaxMessageBytes + 1];
            Assert.That(
                queues.TryEnqueueControl(oversized, out _),
                Is.EqualTo(VisualBridgeEnqueueStatus.MessageTooLarge));
            Assert.That(
                queues.TryEnqueueDebug(oversized, out _, VisualBridgePayloadKind.Binary),
                Is.EqualTo(VisualBridgeEnqueueStatus.MessageTooLarge));
            Assert.That(queues.ControlPendingCount + queues.DataPendingCount, Is.Zero);
            Assert.That(queues.SnapshotCounters().RejectedTooLarge, Is.EqualTo(2));
        }

        [Test]
        public void CloseDiscardsQueuedMessagesAndRejectsFurtherEnqueues()
        {
            var queues = new VisualBridgeSendQueues();
            queues.TryEnqueueControl(Bytes("pending"), out _);
            queues.Close();
            Assert.That(queues.TryDequeue(out _), Is.False);
            Assert.That(
                queues.TryEnqueueControl(Bytes("after-close"), out _),
                Is.EqualTo(VisualBridgeEnqueueStatus.Closed));
        }

        private static byte[] Bytes(string text)
        {
            return Encoding.UTF8.GetBytes(text);
        }

        private static string Text(VisualBridgeQueuedMessage message)
        {
            return Encoding.UTF8.GetString(message.Payload);
        }

        private static List<VisualBridgeQueuedMessage> Drain(VisualBridgeSendQueues queues)
        {
            var messages = new List<VisualBridgeQueuedMessage>();
            while (queues.TryDequeue(out var message))
            {
                messages.Add(message);
            }

            return messages;
        }
    }
}
