## Inspect job deliverables

Open the job detail drawer in **Job Board** and select **Open files in Projects**. Projects expands that job's folder within the workspace tree, including its workers' `artifacts/` directories. Select a deliverable to view, edit supported text, or download it. You can also expand `jobs/` directly in the Projects file tree.

Workers place user-facing deliverables inside their own `artifacts/` directory. The same Projects tree shows intermediate files, logs, and other job contents; there is no separate deliverable-only browser.

## Edit an HTML artifact

In **Projects**, expand `artifacts/` in the file tree to open the server's saved HTML files. Select an HTML file for its sandboxed preview, choose **Edit** for its source, and save explicitly. **New file** can create an HTML document; **Import file** brings an existing file of any type into the workspace root.

Editing a job output in Projects edits that specific file, not an unrelated copy in a separate artifact editor. Existing server files and legacy browser-local snapshots are not deleted by the removal of the separate artifact editor.

## Preview boundaries

HTML previews run in a sandboxed frame. A preview is not the same as deploying a site, and features that need a backend, external assets, or broader browser permissions may not work there. Read the source as well as the rendered result when checking generated HTML.

For multi-file apps or artifacts that need a server, use [Projects -> Run app](#help/projects). That starts a temporary process and serves it through the Workbench's managed preview proxy. It does not expose a new public port or publish a production deployment.

Do not use a generated preview as proof that arbitrary code is safe. Review files before opening them outside the Workbench or sharing them.

## When an output is missing

Check that the worker completed and wrote a deliverable under `artifacts/`. Inspect the worker log and the job folder in [Projects](#help/projects). See [Troubleshooting](#help/troubleshooting).