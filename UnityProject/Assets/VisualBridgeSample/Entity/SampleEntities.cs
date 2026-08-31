using System.Collections.Generic;
using VisualBridge.Runtime;

[assembly: VisualBridgeEntityCatalog("sample.unity.entity", "Unity Gameplay Entities")]
[assembly: VisualBridgeEntityComponentGroup("sample.unity.entity", "sample.unity.group.combat", "Combat")]
[assembly: VisualBridgeEntityComponentGroup("sample.unity.entity", "sample.unity.group.movement", "Movement")]

namespace VisualBridge.Sample
{
    [VisualBridgeEntityType(
        "sample.unity.entity",
        "sample.unity.hero",
        "Hero",
        Aliases = new[] { "sample.unity.hero.legacy" },
        Description = "Player-controlled hero entity.",
        AllowedComponentGroupIds = new[] { "sample.unity.group.combat", "sample.unity.group.movement" })]
    public sealed class HeroEntity
    {
        [VisualBridgeField("name", "Name", Order = 0, DefaultJson = "\"Hero\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;

        [VisualBridgeField("level", "Level", Order = 1, DefaultJson = "1", Editor = VisualBridgeEditorKind.Number, Integer = true, Min = 1)]
        public int Level;
    }

    [VisualBridgeEntityType("sample.unity.entity", "sample.unity.enemy", "Enemy")]
    public sealed class EnemyEntity
    {
        [VisualBridgeField("name", "Name", Order = 0, DefaultJson = "\"Enemy\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    [VisualBridgeEntityComponent("sample.unity.entity", "sample.unity.health", "Health", "sample.unity.group.combat", MenuPath = new[] { "Combat", "Health" })]
    public sealed class HealthComponent
    {
        [VisualBridgeField("maxHealth", "Max Health", Order = 0, DefaultJson = "100", Editor = VisualBridgeEditorKind.Number, Integer = true, Min = 1)]
        public int MaxHealth;

        [VisualBridgeField("regenPerSecond", "Regen Per Second", Order = 1, DefaultJson = "0.5", Editor = VisualBridgeEditorKind.Number, Step = 0.1)]
        public float RegenPerSecond;
    }

    [VisualBridgeEntityComponent("sample.unity.entity", "sample.unity.movement", "Movement", "sample.unity.group.movement")]
    public struct MovementComponent
    {
        [VisualBridgeField("speed", "Speed", Order = 0, DefaultJson = "3.5", Editor = VisualBridgeEditorKind.Number)]
        public float Speed;

        [VisualBridgeField("waypoints", "Waypoints", Order = 1, DataTypeId = "list.float", DefaultJson = "[0,10]")]
        public List<float> Waypoints;
    }
}
