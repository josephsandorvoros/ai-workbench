## Choose what to monitor

The header's **Monitor** selector chooses the Workbench host or a configured remote monitor. It changes the statistics being displayed; it does not switch your model endpoint or move agent execution to another machine.

## Read the metrics

| Metric | Meaning |
| --- | --- |
| CPU | Processor utilization |
| CPU T | Available CPU temperature reading |
| GPU | Reported GPU utilization |
| VRAM | Reported GPU memory usage |
| GPU T | Available GPU temperature |
| RAM | System memory usage |
| Disk | Usage of the configured monitored filesystem |
| Proc | Reported process count |

Disk usage is flagged at 85% and 95%. A missing value (`--`) can mean that the selected source does not provide the sensor or that the request failed. A healthy metric display is not proof that Hermes or a model is ready.

Stats are polled roughly every three seconds. If a fetch fails, existing readings may remain on screen; do not treat them as a guaranteed fresh health check.

## Remote statistics

The appliance can use Glances on the model host through `GLANCES_URL`. Glances API v3 and v4 are supported. Container-local monitoring may not expose GPU data. GPU visibility can require the correct Glances image and GPU access; `GLANCES_GPU_ID` selects a specific GPU when needed.

Keep the Glances endpoint on a trusted network. Do not expose an unauthenticated monitor publicly. Configuration examples are in the [Deployment reference](#help/deployment-reference).