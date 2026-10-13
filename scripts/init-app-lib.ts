/** init-app 的纯逻辑：kit 包 workspace 依赖 → git 子目录依赖（钉 tag） */

export const KIT_REPO = "git+https://github.com/iazrael/nexus-kit.git";

const KIT_PKG = /^@nexus-kit\/(pwa|pwa-react|vite|devflow)$/;

export function kitGitSpec(pkgName: string, version: string): string {
  const dir = pkgName.replace("@nexus-kit/", "");
  return `${KIT_REPO}#v${version}&path:/packages/${dir}`;
}

export function rewriteKitDeps(pkg: Record<string, unknown>, version: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pkg };
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (KIT_PKG.test(name)) next[name] = kitGitSpec(name, version);
      else if (spec.startsWith("workspace:")) throw new Error(`[init-app] ${name} 是未知的 workspace 依赖，不知道怎么改写`);
      else next[name] = spec;
    }
    out[field] = next;
  }
  return out;
}
