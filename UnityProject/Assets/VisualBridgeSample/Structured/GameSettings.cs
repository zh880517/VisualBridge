using System.Collections.Generic;
using Kyl.VisualBridge;

[assembly: VisualBridgeStructuredCatalog("sample.unity.gameplay", "Unity Gameplay Settings")]

namespace VisualBridge.Sample
{
    public enum GameDifficulty
    {
        Easy,
        Normal,
        Hard,
    }

    public struct SpawnSettings
    {
        [VisualBridgeField("lives", "Lives", Order = 0, DefaultJson = "3", Editor = VisualBridgeEditorKind.Number, Integer = true, Min = 1, Max = 9)]
        public int Lives;

        [VisualBridgeField("region", "Region", Order = 1, DefaultJson = "\"center\"", Editor = VisualBridgeEditorKind.Text)]
        public string Region;
    }

    [VisualBridgeStructuredConfig(
        "sample.unity.gameplay",
        "sample.unity.game.settings",
        "Game Settings",
        Aliases = new[] { "legacy.unity.game.settings" },
        Description = "Plain CLR settings exported without constructing the config type.")]
    public sealed class GameSettings
    {
        public static int ConstructorCallCount;

        public GameSettings()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("maxPlayers", "Max Players", Order = 0, Aliases = new[] { "playerLimit" }, DefaultJson = "5", Editor = VisualBridgeEditorKind.Number, Integer = true, Min = 1, Max = 10, Step = 1)]
        public int MaxPlayers;

        [VisualBridgeField("difficulty", "Difficulty", Order = 1, DefaultJson = "\"Normal\"")]
        public GameDifficulty Difficulty;

        [VisualBridgeField("friendlyFire", "Friendly Fire", Order = 2, DefaultJson = "false", Editor = VisualBridgeEditorKind.Checkbox)]
        public bool FriendlyFire;

        [VisualBridgeField("serverName", "Server Name", Order = 3, DefaultJson = "\"Local Development\"", Editor = VisualBridgeEditorKind.Text)]
        public string ServerName;

        [VisualBridgeField("spawn", "Spawn", Order = 4)]
        public SpawnSettings Spawn;

        [VisualBridgeField("checkpoints", "Checkpoints", Order = 5, DataTypeId = "list.int", DefaultJson = "[0,10]")]
        public List<int> Checkpoints;
    }
}
