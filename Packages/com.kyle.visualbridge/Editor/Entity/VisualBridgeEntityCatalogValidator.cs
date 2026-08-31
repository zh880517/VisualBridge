using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    internal static class VisualBridgeEntityCatalogValidator
    {
        public static void Validate(JObject catalog)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                catalog,
                "$",
                new[] { "formatVersion", "catalogId", "title", "source", "componentGroups", "entityTypes", "componentTypes" },
                Array.Empty<string>());
            VisualBridgeStructuredCatalogValidator.RequireInteger(catalog["formatVersion"], "$.formatVersion", 1);
            VisualBridgeStructuredCatalogValidator.RequireIdentifier(catalog["catalogId"], "$.catalogId");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(catalog["title"], "$.title");
            VisualBridgeStructuredCatalogValidator.ValidateSource(
                VisualBridgeStructuredCatalogValidator.RequireObject(catalog["source"], "$.source"),
                "$.source");

            var groupIds = new HashSet<string>(StringComparer.Ordinal);
            var componentGroups = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["componentGroups"], "$.componentGroups", false);
            for (var index = 0; index < componentGroups.Count; index++)
            {
                ValidateComponentGroup(
                    VisualBridgeStructuredCatalogValidator.RequireObject(componentGroups[index], $"$.componentGroups[{index}]"),
                    $"$.componentGroups[{index}]",
                    groupIds);
            }

            var entityTypeIds = new HashSet<string>(StringComparer.Ordinal);
            var entityTypes = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["entityTypes"], "$.entityTypes", false);
            for (var index = 0; index < entityTypes.Count; index++)
            {
                ValidateEntityType(
                    VisualBridgeStructuredCatalogValidator.RequireObject(entityTypes[index], $"$.entityTypes[{index}]"),
                    $"$.entityTypes[{index}]",
                    groupIds,
                    entityTypeIds);
            }

            var componentTypeIds = new HashSet<string>(StringComparer.Ordinal);
            var componentTypes = VisualBridgeStructuredCatalogValidator.RequireArray(catalog["componentTypes"], "$.componentTypes", false);
            for (var index = 0; index < componentTypes.Count; index++)
            {
                ValidateComponentType(
                    VisualBridgeStructuredCatalogValidator.RequireObject(componentTypes[index], $"$.componentTypes[{index}]"),
                    $"$.componentTypes[{index}]",
                    groupIds,
                    componentTypeIds);
            }
        }

        private static void ValidateComponentGroup(JObject group, string path, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(group, path, new[] { "id", "title" }, new[] { "aliases" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(group["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(group["title"], path + ".title");
            if (group["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(group["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }
        }

        private static void ValidateEntityType(JObject entityType, string path, HashSet<string> groupIds, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                entityType,
                path,
                new[] { "id", "title", "allowedComponentGroupIds", "properties" },
                new[] { "aliases", "description" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(entityType["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(entityType["title"], path + ".title");
            if (entityType["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(entityType["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            if (entityType["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(entityType["description"], path + ".description");
            }

            foreach (var groupId in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(entityType["allowedComponentGroupIds"], path + ".allowedComponentGroupIds"))
            {
                if (!groupIds.Contains(groupId))
                {
                    throw Error("catalog.invalidReference", path + ".allowedComponentGroupIds", $"Unknown component group '{groupId}'.");
                }
            }

            var properties = VisualBridgeStructuredCatalogValidator.RequireArray(entityType["properties"], path + ".properties", false);
            VisualBridgeStructuredCatalogValidator.ValidateFields(properties, path + ".properties");
        }

        private static void ValidateComponentType(JObject componentType, string path, HashSet<string> groupIds, HashSet<string> identities)
        {
            VisualBridgeStructuredCatalogValidator.RequireKeys(
                componentType,
                path,
                new[] { "id", "title", "groupId", "properties" },
                new[] { "aliases", "description", "menuPath", "source" });
            var id = VisualBridgeStructuredCatalogValidator.RequireIdentifier(componentType["id"], path + ".id");
            AddIdentity(identities, id, path + ".id");
            VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(componentType["title"], path + ".title");
            if (componentType["aliases"] != null)
            {
                foreach (var alias in VisualBridgeStructuredCatalogValidator.RequireIdentifierArray(componentType["aliases"], path + ".aliases"))
                {
                    AddIdentity(identities, alias, path + ".aliases");
                }
            }

            if (componentType["description"] != null)
            {
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(componentType["description"], path + ".description");
            }

            if (componentType["menuPath"] != null)
            {
                var menuPath = VisualBridgeStructuredCatalogValidator.RequireArray(componentType["menuPath"], path + ".menuPath", false);
                for (var index = 0; index < menuPath.Count; index++)
                {
                    VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(menuPath[index], $"{path}.menuPath[{index}]");
                }
            }

            if (componentType["source"] != null)
            {
                var source = VisualBridgeStructuredCatalogValidator.RequireObject(componentType["source"], path + ".source");
                VisualBridgeStructuredCatalogValidator.RequireKeys(source, path + ".source", new[] { "providerId", "typeName" }, Array.Empty<string>());
                VisualBridgeStructuredCatalogValidator.RequireIdentifier(source["providerId"], path + ".source.providerId");
                VisualBridgeStructuredCatalogValidator.RequireNonEmptyString(source["typeName"], path + ".source.typeName");
            }

            var groupId = VisualBridgeStructuredCatalogValidator.RequireIdentifier(componentType["groupId"], path + ".groupId");
            if (!groupIds.Contains(groupId))
            {
                throw Error("catalog.invalidReference", path + ".groupId", $"Unknown component group '{groupId}'.");
            }

            var properties = VisualBridgeStructuredCatalogValidator.RequireArray(componentType["properties"], path + ".properties", false);
            VisualBridgeStructuredCatalogValidator.ValidateFields(properties, path + ".properties");
        }

        private static void AddIdentity(HashSet<string> identities, string identity, string path)
        {
            if (!identities.Add(identity))
            {
                throw Error("catalog.identityConflict", path, $"Identity '{identity}' is already used.");
            }
        }

        private static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return VisualBridgeIntegrationProfileLoader.Error(code, path, message);
        }
    }
}
