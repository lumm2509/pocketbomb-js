/**
 * Converts the manifest scopes to an installation grant:
 * read_{c} -> list/view, write_{c} -> list/view/create/update/delete (the collection must exist),
 * system:{read|write}_{resource} -> the resource level, write_app_proxy -> the app proxy resource.
 *
 * @throws {Error} for a scope of a missing collection.
 */
export function scopesToPermissions(
  scopes: Array<string>,
  collections: Array<{ id: string; name: string }>,
): { collections: Record<string, Array<string>>; system: Record<string, string> } {
  const result = {
    collections: {} as Record<string, Array<string>>,
    system: {} as Record<string, string>,
  };

  for (const scope of scopes) {
    if (scope === "write_app_proxy") {
      result.system.app_proxy = "write";
      continue;
    }

    const system = scope.match(/^system:(read|write)_(.+)$/);
    if (system) {
      const [, level, resource] = system;
      if (result.system[resource] !== "write") {
        result.system[resource] = level;
      }
      continue;
    }

    const match = scope.match(/^(read|write)_(.+)$/);
    if (!match) {
      throw new Error("Invalid scope " + scope + ".");
    }

    const [, kind, name] = match;
    const collection = collections.find((c) => c.name === name);
    if (!collection) {
      throw new Error("The scope " + scope + " refers to the missing collection " + name + ".");
    }

    const actions = new Set(result.collections[collection.id] || []);
    actions.add("list").add("view");
    if (kind === "write") {
      actions.add("create").add("update").add("delete");
    }
    result.collections[collection.id] = [...actions];
  }

  return result;
}
