import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageLicense(manifest, locked) {
  const declared = manifest.license || manifest.licenses || locked.license;
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) return declared.map((entry) => entry.type).join(" OR ");
  if (declared?.type) return declared.type;
  return null;
}

export function localNotices(directory) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice|copyright|third.?party)/i.test(entry.name))
    .map((entry) => ({ file: entry.name, text: readFileSync(path.join(directory, entry.name), "utf8") }));
  if (!files.length) {
    for (const filename of ["README.md", "readme.md"]) {
      const location = path.join(directory, filename);
      if (!existsSync(location)) continue;
      const text = readFileSync(location, "utf8");
      if (/Permission is hereby granted/.test(text) && /SOFTWARE IS PROVIDED/.test(text) && /Copyright/.test(text)) {
        files.push({ file: filename, text });
      }
    }
  }
  return files;
}

export function checkedNotice(text, expected, label) {
  if (createHash("sha256").update(text).digest("hex") !== expected) {
    throw new Error(`Upstream license changed: ${label}; review before updating its checksum.`);
  }
  return text;
}

export function sourceNoticeHeader(text) {
  const withoutDirective = text.replace(/^\s*["']use strict["'];?\s*/, "");
  const header = withoutDirective.match(/^\/\/[^\n]*(?:\n\/\/[^\n]*)*/)?.[0];
  return header && /copyright|\(C\)/i.test(header) ? header : null;
}

export async function collectNotices(frontend, fetchNotice = fetch) {
  const project = path.resolve(frontend, "..");
  const policy = JSON.parse(readFileSync(path.join(project, "licenses", "frontend-sources.json"), "utf8"));
  const locked = JSON.parse(readFileSync(path.join(frontend, "package-lock.json"), "utf8"));
  const remote = new Map();
  async function sourceNotice(id) {
    if (!remote.has(id)) {
      const source = policy.sources[id];
      if (!source) throw new Error(`Unreviewed license source: ${id}`);
      const response = await fetchNotice(source.url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`License download failed: ${id} (HTTP ${response.status})`);
      const text = checkedNotice(await response.text(), source.sha256, id);
      remote.set(id, { file: source.url, text });
    }
    return remote.get(id);
  }
  const packages = [];
  for (const [relative, entry] of Object.entries(locked.packages)) {
    if (!relative || entry.dev) continue;
    const directory = path.join(frontend, relative);
    const manifestFile = path.join(directory, "package.json");
    if (!existsSync(manifestFile)) {
      if (entry.optional) continue;
      throw new Error(`Required dependency is not installed: ${relative}`);
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (manifest.version !== entry.version) throw new Error(`Installed dependency differs from lockfile: ${relative}`);
    let license = packageLicense(manifest, entry);
    const override = policy.packages[`${manifest.name}@${manifest.version}`];
    if (!license && override?.license) license = override.license;
    if (!license || !policy.allowedLicenses.includes(license)) {
      throw new Error(`Unreviewed license for ${manifest.name}@${manifest.version}: ${license}`);
    }
    const notices = localNotices(directory);
    if (!notices.length) {
      const source = override?.source || (policy.radixPackages[manifest.name]?.includes(manifest.version) ? "radix" : null);
      if (!source) throw new Error(`Missing license text: ${manifest.name}@${manifest.version}`);
      notices.push(await sourceNotice(source));
    }
    if (manifest.name === "pako") {
      const zlib = path.join(directory, "lib", "zlib");
      for (const filename of readdirSync(zlib).filter((name) => name.endsWith(".js"))) {
        const header = sourceNoticeHeader(readFileSync(path.join(zlib, filename), "utf8"));
        if (header) notices.push({ file: `lib/zlib/${filename} (original notice header)`, text: header });
      }
      if (!notices.some((notice) => notice.text.includes("This notice may not be removed"))) {
        throw new Error("Review pako's missing Zlib copyright/permission text.");
      }
    }
    const attribution = {
      author: manifest.author || null, contributors: manifest.contributors || [],
      repository: manifest.repository || null, homepage: manifest.homepage || null,
    };
    packages.push({ name: manifest.name, version: manifest.version, license, path: relative, attribution, notices });
  }
  const excalidraw = packages.find((entry) => entry.name === "@excalidraw/excalidraw");
  if (!excalidraw || excalidraw.version !== policy.excalidrawVersion) {
    throw new Error("Review font licenses for the installed Excalidraw version.");
  }
  const fontRoot = path.join(frontend, excalidraw.path, "dist", "prod", "fonts");
  const evidence = JSON.parse(execFileSync("python3", [path.join(frontend, "scripts", "font-notices.py"), fontRoot], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
  const fonts = [];
  for (const entry of evidence) {
    if (!Object.hasOwn(policy.fonts, entry.name)) throw new Error(`Unreviewed font family: ${entry.name}`);
    const source = policy.fonts[entry.name];
    fonts.push({ ...entry, notice: source ? await sourceNotice(source) : null });
  }
  return { packages, fonts, project, ofl: await sourceNotice("ofl") };
}

export async function generateNotices(frontend) {
  const { packages, fonts, project, ofl } = await collectNotices(frontend);
  const output = path.join(frontend, "dist", "licenses");
  if (!existsSync(path.join(frontend, "dist", "index.html"))) throw new Error("Build the frontend before generating notices.");
  mkdirSync(output, { recursive: true });
  const sections = [
    "AI Workbench third-party notices",
    "Workbench's MIT license does not replace the licenses below. This inventory covers installed locked runtime npm packages and Excalidraw fonts, not OS images or native Rust dependencies.",
    readFileSync(path.join(project, "LICENSE"), "utf8"),
    readFileSync(path.join(project, "THIRD_PARTY_NOTICES.md"), "utf8"),
  ];
  for (const entry of packages) {
    sections.push(`${entry.name}@${entry.version}\nDeclared license: ${entry.license}\nAttribution and source: ${JSON.stringify(entry.attribution)}`);
    for (const notice of entry.notices) sections.push(`${notice.file}\n\n${notice.text}`);
  }
  sections.push(`OFL reference template; actual font copyright holders are preserved below.\n${ofl.file}\n\n${ofl.text}`);
  for (const font of fonts) {
    sections.push(`Excalidraw font: ${font.name}\n${font.embeddedNotices.join("\n\n")}`);
    if (font.notice) sections.push(`${font.notice.file}\n\n${font.notice.text}`);
  }
  writeFileSync(path.join(output, "THIRD_PARTY_NOTICES.txt"), sections.join("\n\n========================================\n\n"));
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
    packages: packages.map(({ notices, ...entry }) => ({ ...entry, noticeFiles: notices.map((notice) => notice.file) })),
    fonts: fonts.map((font) => ({ name: font.name, files: font.files, source: font.notice?.file || "embedded font metadata" })),
  }, null, 2) + "\n");
  writeFileSync(path.join(output, "font-evidence.json"), JSON.stringify(fonts, null, 2) + "\n");
  console.log(`License notices: ${packages.length} package installations and ${fonts.length} font families.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateNotices(path.resolve(fileURLToPath(new URL("..", import.meta.url)))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}