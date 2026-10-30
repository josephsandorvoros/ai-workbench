## Check versions

Open **Terminal** to see installed and latest versions. The header's update indicator opens that workspace. An available update is informational; it does not automatically change your installation.

| Component | Update path |
| --- | --- |
| OpenCode | Use its **Update** button for a supported in-place update |
| Hermes Agent | Use its **Update** button for a managed runtime update |
| Workbench image | Re-pull the image and redeploy through your deployment process |
| Sandbox | Re-pull the sandbox image and redeploy through your deployment process |

The update-method note appears beside each component's current status. Hermes and OpenCode buttons remain visible, but are disabled when no update is available or the update path is unsupported. Version checks and notes do not trigger updates.

OpenCode in-place updates persist in the Hermes data volume until an image includes the same or newer version. `UPDATE_CHECK=0` disables Workbench version checks; it is not a switch that blocks every tool's network activity.

## Update Hermes

The upstream `hermes update` CLI command is not the Workbench managed updater. It can refuse to run inside Docker even when Workbench supports in-place updates. Use the **Hermes Agent** row's **Update** action instead; it does not require rebuilding the Workbench container. Do not replace the Workbench agent image with the stock upstream Hermes image suggested by that CLI message.

In **Terminal -> Versions**, use **Check now** to refresh versions. Use **Update** in the **Hermes Agent** row to install the checked release. Progress and errors appear in that row's status column. There is no separate update panel, version input, or Roll Back button. Confirm only after finishing active chats and jobs. The app stages the selected upstream release and locked Python dependencies before restarting Hermes, then checks the gateway and private chat protocol without sending a model prompt. Provider/model settings remain in Agent Workbench's separate **Hermes inference & runtime** column.

Failed preparation leaves the selected runtime unchanged. Failed activation attempts to restore the previous runtime and pre-activation configuration automatically. Recovery does not reverse arbitrary database migrations or replace data backups. A recovery failure requires operator attention.

Release files persist in the Hermes data volume across container recreation, but their virtualenv may reference a Python interpreter supplied by the image. An image upgrade can invalidate that interpreter path; startup recovery checks that Python and Hermes execute, then falls back to an available runtime. Recovery history remains in the runtime API but is not shown as a standing warning in Versions. The ordinary version status is not a service-health check. Local non-container installs cannot use these runtime actions. New Python/OS requirements may still need an image upgrade. Workbench itself still updates through appliance images.

## Update OpenCode

Use the **OpenCode -> Update** button and confirm after finishing active OpenCode work and jobs. The action opens a shell, installs the supported update, and shows its output in Terminal. Appliance installs use `workbench-update opencode`, which installs into the persistent data volume and attempts to restart the headless OpenCode server. If that restart is unavailable, the output asks for an administrator-managed container restart. Use **Check now** after completion to refresh the displayed version. Worker containers have their own image and credentials; updating main OpenCode does not update existing workers.

## Before an update

1. Review the release notes and selected image tag.
2. Finish or deliberately stop active work. Reloading a harness or recreating a container can interrupt sessions and jobs.
3. Back up persistent data and record the current configuration.
4. Use the deployment's normal update procedure, preserving volumes and sandbox settings.
5. Afterward, verify connections, workspace files, and worker behavior before starting important work.

Help pages are bundled with the installed frontend. Updating the app updates these pages; opening Help does not fetch live documentation or change the installation.

## What to back up

- The **Hermes data volume**: agent state, skills, memory, settings, model keys, OpenCode configuration, and job state.
- The **workspace volume**: projects, wiki files, job inputs and deliverables, and HTML artifacts.
- The deployment's Compose files, environment configuration, selected image tags, and any separately mounted data.

Store backups securely: they may contain credentials and private conversations. Browser-local snapshots are convenience copies, not a complete appliance backup.

## Back up and restore consistently

Use an administrator-approved, application-consistent backup procedure. Avoid copying a live database file without its required transaction state; use an appropriate database backup method or quiesce writers first. On restore, check ownership, paths, image compatibility, and access restrictions before reconnecting clients.

Do not remove persistent volumes to solve a version or connection problem. Read [Troubleshooting](#help/troubleshooting) first. The [Deployment reference](#help/deployment-reference) contains the installation layout and operating details.