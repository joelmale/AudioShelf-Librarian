import fs from "node:fs";
import path from "node:path";

export class PathSecurityError extends Error {}

async function realpathExistingOrParent(input: string): Promise<string> {
  let current = path.resolve(input);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new PathSecurityError(`No existing parent for path`);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(await fs.promises.realpath(current), ...suffix);
}

export async function assertContained(
  candidate: string,
  root: string,
  options: { allowRoot?: boolean; mustExist?: boolean } = {}
): Promise<string> {
  const realRoot = await fs.promises.realpath(path.resolve(root));
  if (options.mustExist && !fs.existsSync(candidate)) {
    throw new PathSecurityError("Path does not exist");
  }
  const realCandidate = await realpathExistingOrParent(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === "" && !options.allowRoot) {
    throw new PathSecurityError("Operation against configured root is forbidden");
  }
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new PathSecurityError("Path is outside the configured root");
  }
  return realCandidate;
}

export async function assertContainedInAny(
  candidate: string,
  roots: string[],
  options: { allowRoot?: boolean; mustExist?: boolean } = {}
): Promise<string> {
  for (const root of roots) {
    try {
      return await assertContained(candidate, root, options);
    } catch (error) {
      if (!(error instanceof PathSecurityError)) throw error;
    }
  }
  throw new PathSecurityError("Path is outside all configured roots");
}
