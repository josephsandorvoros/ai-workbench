# Third-Party Software and Release Review

Review date: 2026-10-30. This is an engineering inventory, not legal certification.

AI Workbench's original code is licensed under [MIT](LICENSE). That grant does not replace third-party copyrights, licenses, font terms, trademarks, model licenses, service terms, or source-code obligations. No endorsement by upstream projects is implied.

## Release Status

The licensing review remains **pending**, not a compliance certification. At the maintainer's request, Liberation replacement is deferred to a later update and the publishing setup can proceed with a visible warning. The frontend notice fixes address identified omissions, but the following remain open obligations and follow-up work:

1. The actual bundled `LiberationSans-Regular.woff2` identifies 2007 Ascender data and points to its original license agreement. Do not apply the current Liberation 2.x OFL license to this older binary. Establish its exact legacy license, font exception, and any source obligations, or approve replacement with a verifiably licensed compatible asset. No replacement was made automatically.
2. Audit the exact four final image digests, including upstream Hermes' Python/native dependencies and OpenCode's bundled dependencies. The Dockerfiles use moving `latest` inputs for Hermes, OpenCode, Docker DinD, and some base images. Today's upstream root licenses do not establish the terms of every release or embedded dependency.
3. Fulfil applicable corresponding-source requirements for redistributed GPL/LGPL programs and libraries, including OS packages, rather than merely linking to upstream homepages. Preserve notices and supply the matching sources, build scripts, patches, or another valid license-specific mechanism. No source-offer promise is made by this document.
4. Desktop installers are not cleared: inventory and preserve the licenses of the exact Cargo/native/WebView dependencies for each target before distributing Tauri binaries. Adding MIT to the project's Cargo manifest does not relicense its dependencies.

The machine-readable [review status](licenses/review.json) stays pending and prints a warning during publication. Deferring work does not waive third-party license or source-delivery obligations, and does not mean they have been satisfied. Do not change the review to approved without evidence. This review does not retroactively assess already-published Forgejo images.

## Included Frontend Projects

The package lockfile is the authority for exact npm versions, including nested duplicates. `npm run licenses` generates `/licenses/THIRD_PARTY_NOTICES.txt`, `/licenses/manifest.json`, and `/licenses/font-evidence.json` inside the compiled frontend. It preserves complete installed runtime-package license/notice files, including Monaco's `ThirdPartyNotices.txt`. Full MIT notices embedded in fastdom/strictdom READMEs are retained. Packages that omit notice files use explicitly version-reviewed, checksummed upstream texts. Missing/unknown license declarations, missing notice text, changed remote text, changed Excalidraw versions, and new font families fail generation.

This inventory includes installed locked runtime dependencies conservatively, not just modules surviving tree-shaking. Build-only tools are not represented as browser runtime components. Missing optional packages for other platforms are skipped; missing required packages fail. It is not a scanner of the final container or a complete license compatibility solver.

| Project | Reviewed version or source | Terms and treatment |
| --- | --- | --- |
| React / React DOM | Locked npm versions | MIT; retain notices. |
| Monaco Editor | 0.57.0 | MIT plus separate third-party notices; retain both in the delivered app. |
| Monaco React wrapper | 4.8.0-rc.3 | MIT; retain notice. |
| Excalidraw | 0.18.1, upstream commit `a2ec2889babf7d2295469c6d90ebe77fae57df84` | MIT for code, not a blanket license for its font files. |
| xterm.js / addon-fit | Locked npm versions | MIT; retain notices. |
| React Markdown / remark / unified ecosystem | Locked npm versions | Primarily MIT, with each installed package's actual declaration and text retained. |
| highlight.js | Locked npm version | BSD-3-Clause; preserve copyright, conditions, and disclaimer. |
| jsonc-parser | 3.3.1 | MIT; retain notice. |
| react-resizable-panels | 3.0.6 | MIT; package omits text, so retain the upstream release commit's notice. |
| Radix UI primitives | Exact reviewed nested versions in `licenses/frontend-sources.json` | MIT; package omissions covered by checksummed upstream notice. Recheck on upgrades. |
| fastdom / strictdom / react-remove-scroll-bar | 1.0.12 / 1.0.1 / 2.3.8 | MIT; preserve embedded or checksummed upstream notices. |
| DOMPurify | 3.4.17 | Dual `MPL-2.0 OR Apache-2.0`; Apache-2.0 is the selected alternative for this distribution. Both supplied license texts remain included; no modifications to DOMPurify are claimed. |
| pako | Locked npm version | MIT AND Zlib; preserve both applicable notices, not just the MIT label. |
| caniuse-lite | Locked npm version, build-only | CC-BY-4.0 data; not included in the current runtime inventory. If redistributed in a future runtime bundle, retain its license, attribution, source information, and applicable change notices. Not relabeled MIT. |
| fuzzy / khroma | Locked npm versions | MIT verified from legacy metadata/packaged license text rather than assuming missing metadata means MIT. |
| Other runtime packages | Generated manifest | Reviewed declared families include MIT, ISC, BSD, Apache, CC0, Unlicense and their explicitly listed combinations. Inclusion in that list is not blanket approval of arbitrary future dependencies. |

## Fonts and Other Assets

Every distributed Excalidraw font file is hashed and its embedded copyright/license fields are extracted using FreeType. The evidence is shipped with the frontend; filenames and actual copyright text are preserved. The collector does not modify fonts, rename families, or claim MIT for all assets.

| Font family | Evidence and obligation |
| --- | --- |
| Assistant | Embedded Assistant / Source Sans Pro copyright and OFL-1.1 reference; retain attribution and reserved-name restrictions. |
| Cascadia | Embedded Microsoft copyright and full font-specific permission terms; preserve those exact terms as well as the OFL reference. |
| ComicShanns | Embedded full MIT notice with Shannon Miwa and subsequent contributors. |
| Excalifont | Excalidraw 2024 copyright; version-pinned upstream font metadata contains OFL-1.1 text. |
| Liberation | **Deferred**: bundled 2007 Ascender binary has legacy provenance; modern Liberation OFL text is not adequate evidence. Replacement is planned for a later update. |
| Lilita | Embedded Juan Montoreano copyright/reserved font name and OFL reference. |
| Nunito | Embedded Nunito Project Authors copyright and OFL reference. |
| Virgil | The bundled binary embeds Your Own Font Foundry 2011 copyright and full OFL-1.1. The current marketing page contradicts itself (MIT and OFL); binary evidence takes precedence for this review. |
| Xiaolai | Embedded LXGW 2020 copyright; pinned Excalidraw font metadata declares OFL-1.1. |

OFL fonts must remain under their font license, cannot be sold by themselves, and may have reserved-name restrictions on modified versions. Merely producing documents with a font does not apply the font license to those documents. Excalidraw's modified/subset assets must be assessed as shipped, not replaced with unrelated current upstream notices.

Additional Liberation evidence: [the licensing history](https://en.wikipedia.org/wiki/Liberation_fonts) distinguishes older GPL releases with a font-embedding exception from version 2 onward's OFL releases. [Adobe's linked Liberation Sans Regular license](https://fonts.adobe.com/variations/31/eula) is OFL-1.1 and names Google 2010 and Red Hat 2012 copyrights; it does not establish a grant for the bundled Ascender 2007 binary. The embedding exception does not by itself waive font-file redistribution/source obligations. A verified modern OFL replacement is a possible resolution, but requires approval and compatibility checks for existing scenes and exports. No Adobe-hosted font was downloaded or substituted.

The CSS's Inter/system-font names are fallback preferences, not evidence that those operating-system fonts are redistributed. The small desktop icon and the local promise-pool shim require original-asset provenance confirmation by the maintainer; no third-party provenance was established by filename alone. External/model/user-uploaded content is not granted rights by Workbench's MIT license.

## Runtime and Container Projects

| Project/component | Reviewed root license | Required handling |
| --- | --- | --- |
| Hermes Agent | MIT, copyright 2025 Nous Research | Keep its license and inspect the exact image's Python/native dependencies and any generated/bundled material. |
| OpenCode | MIT, copyright 2025 opencode | Keep license, inspect exact installed/bundled dependencies and native executables; updating the CLI can change this inventory. |
| Herdr | Apache-2.0, pinned 0.9.5 | Agent image preserves the tagged root LICENSE. Audit the exact binary's embedded/native dependencies and notices before publishing; this addition does not complete the pending release review. |
| uv 0.11.16 | MIT OR Apache-2.0, copyright 2025 Astral Software Inc. | MIT alternative selected for uv itself; do not treat the copied binary's embedded dependencies as covered by that alone. The extra MIT notice below accompanies the binary-only copy. |
| PyYAML 6.0.3 | MIT | Retain Ingy dot Net / Kirill Simonov notices and inspect any bundled LibYAML/native component. |
| Node.js | MIT plus bundled third-party notices | Preserve Node's complete notice bundle, not just the project MIT heading. |
| Caddy | Apache-2.0 | Preserve license/NOTICE material and inspect bundled Go modules for the exact build. |
| Docker/Moby/DinD | Core code Apache-2.0; aggregate image has additional licenses | Preserve Docker/containerd/runc/BuildKit and distribution notices; audit exact installed components. Docker Desktop is not what the sandbox image redistributes. |
| Debian / Alpine packages | Mixed, including GPL/LGPL and permissive licenses | Preserve available copyright/license information and fulfil corresponding-source requirements where applicable. |
| Git | GPL-2.0 | Standalone executable does not relicense independent Workbench code, but binary redistribution still requires GPL compliance. |
| BusyBox / shell/network utilities | Version/component-specific, often GPL | Same source/notice obligations; an upstream source URL alone is not blanket compliance. |
| Python | PSF and bundled third-party licenses | Preserve its license bundle and package-specific notices. |
| curl / jq / ripgrep / TLS libraries / s6 | Component/version-specific | Inventory exact builds and preserve all applicable notices; no aggregate MIT claim. |
| Tauri / Rust / platform WebView | Tauri generally MIT OR Apache-2.0; dependencies vary | Native desktop distribution remains a separate release gate. |

The four image recipes copy Workbench's MIT license, this review, and supplemental MIT notices to `/usr/share/licenses/ai-workbench/`; the web image also ships generated browser notices under `/srv/licenses/`. Those additions do not supply missing OS corresponding source or certify upstream aggregate images.

## External Services and Catalogue Data

ClawLabsAI/free-ai-models (MIT, 2026 ClawLabs AI), Models.dev (MIT, 2025 models.dev), and the inspiration project omarchy-freemodels (MIT, 2026 ArgusGuardian) are acknowledged in the supplemental notices. The frontend/backend call public catalogues; this does not redistribute model weights or grant rights to models or hosted services. OpenCode Zen, speech endpoints, model APIs, Glances, user-installed MCP servers, and user-uploaded content have their own terms. They are not relicensed by this repository.

## Supplemental MIT Notices

The complete standard MIT permission/disclaimer text below applies separately to the following copyright notices, not as a replacement for their own dependencies' terms:

- Copyright (c) 2025 Nous Research (Hermes Agent)
- Copyright (c) 2025 opencode (OpenCode)
- Copyright (c) 2025 Astral Software Inc. (uv 0.11.16)
- Copyright (c) 2017-2021 Ingy döt Net; Copyright (c) 2006-2016 Kirill Simonov (PyYAML 6.0.3)
- Copyright (c) 2026 ClawLabs AI (free-ai-models)
- Copyright (c) 2025 models.dev (Models.dev)
- Copyright (c) 2026 ArgusGuardian (omarchy-freemodels)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Evidence and Maintenance

Primary sources checked include the installed npm license files and lockfile, the actual WOFF2 name tables, Excalidraw's `v0.18.1` source, [Hermes LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [OpenCode LICENSE](https://github.com/anomalyco/opencode/blob/dev/LICENSE), [uv 0.11.16 licenses](https://github.com/astral-sh/uv/tree/0.11.16), [PyYAML 6.0.3 LICENSE](https://github.com/yaml/pyyaml/blob/6.0.3/LICENSE), and the catalogue projects' license files. Upstream source URLs/checksums used by frontend generation are in [frontend-sources.json](licenses/frontend-sources.json). Branch-based URLs are content-hash checked and deliberately fail if changed.

Every release needs an exact artifact inventory, preservation of required notices, verification of relevant source delivery, and review of changed dependencies. Tests establish packaging behavior, not a legal opinion or blanket compliance certification. The unresolved items above still require evidence; proceeding with publishing setup does not establish that redistribution obligations are fulfilled.

The optional native inventory could not be completed offline: Cargo requires an uncached `android_system_properties` crate. No crates were downloaded or native binaries built. The desktop gate therefore remains open.