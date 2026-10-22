using System;
using NUnit.Framework;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeDebugContractAttributeTests
    {
        [Test]
        public void DebugerAttributeUsesDocumentedDefaults()
        {
            var attribute = new VisualBridgeDebugerAttribute("graph");

            Assert.That(attribute.Category, Is.EqualTo("graph"));
            Assert.That(attribute.GeneratedDirectory, Is.Null);
            Assert.That(attribute.Version, Is.EqualTo(1));
            Assert.That(attribute.Kind, Is.EqualTo(VisualBridgeDebugerKind.Event));
            Assert.That(attribute.InstanceParameter, Is.Null);
            Assert.That(attribute.FrameParameter, Is.Null);
        }

        [TestCase("  ")]
        [TestCase("")]
        [TestCase("\t\n")]
        public void DebugerAttributeRejectsWhiteSpaceCategory(string category)
        {
            Assert.Throws<ArgumentException>(() => new VisualBridgeDebugerAttribute(category));
        }

        [Test]
        public void DebugerAttributeRejectsNullCategory()
        {
            Assert.Throws<ArgumentException>(() => new VisualBridgeDebugerAttribute(null));
        }

        [Test]
        public void DebugerAttributeTrimsCategory()
        {
            var attribute = new VisualBridgeDebugerAttribute("  graph  ");

            Assert.That(attribute.Category, Is.EqualTo("graph"));
        }

        [Test]
        public void DebugTagAttributeExposesTag()
        {
            var attribute = new VisualBridgeDebugTagAttribute(10);

            Assert.That(attribute.Tag, Is.EqualTo(10));
        }

        [Test]
        public void DebugTagAttributePreservesNegativeTag()
        {
            var attribute = new VisualBridgeDebugTagAttribute(-1);

            Assert.That(attribute.Tag, Is.EqualTo(-1));
        }

        [Test]
        public void DebugerKindHasDocumentedValues()
        {
            Assert.That((int)VisualBridgeDebugerKind.Event, Is.EqualTo(0));
            Assert.That((int)VisualBridgeDebugerKind.Query, Is.EqualTo(1));
        }

        [Test]
        public void ConnectTypeHasDocumentedValues()
        {
            Assert.That((int)VisualBridgeConnectType.Editor, Is.EqualTo(0));
            Assert.That((int)VisualBridgeConnectType.EditorPlayer, Is.EqualTo(1));
            Assert.That((int)VisualBridgeConnectType.Player, Is.EqualTo(2));
        }
    }
}
