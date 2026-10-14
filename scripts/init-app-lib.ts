/** init-app 的纯逻辑：kit 包 workspace 依赖 → git 子目录依赖（钉 tag） */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KIT_REPO = "git+https://github.com/iazrael/nexus-kit.git";

/** kit 的全部包名：读 packages/<目录>/package.json 的 name，新增包不用改这里 */
export function kitPackageNames(packagesDir: string): Set<string> {
  const names = new Set<string>();
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    const manifest = join(packagesDir, dir.name, "package.json");
    if (!dir.isDirectory() || !existsSync(manifest)) continue;
    const name: unknown = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && name.startsWith("@nexus-kit/")) names.add(name);
  }
  return names;
}

export function kitGitSpec(pkgName: string, version: string): string {
  const dir = pkgName.replace("@nexus-kit/", "");
  return `${KIT_REPO}#v${version}&path:/packages/${dir}`;
}

export function rewriteKitDeps(pkg: Record<string, unknown>, version: string, kitNames: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pkg };
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (kitNames.has(name)) next[name] = kitGitSpec(name, version);
      else if (spec.startsWith("workspace:")) throw new Error(`[init-app] ${name} 是未知的 workspace 依赖，不知道怎么改写`);
      else next[name] = spec;
    }
    out[field] = next;
  }
  return out;
}
