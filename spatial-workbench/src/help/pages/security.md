## Access is powerful

The Workbench has **no application login by default**. Someone who reaches it may be able to operate the agent, files, and tools. The installer binds the interface to the VM's loopback address by default. Keep that boundary or add authentication and network restrictions before making it reachable elsewhere.

Use an SSH tunnel from your own computer for loopback access. Keep the tunnel open while browsing. The SSH password is your VM account password, not the Workbench terminal token. For remote access, secure the proxy and restrict the app port so users cannot bypass that proxy.

`WORKBENCH_AUTH=proxy` trusts an upstream authentication layer; it does not create one. `WORKBENCH_ALLOWED_CLIENTS` checks the direct network peer, not the forwarded end-user IP. With a separate proxy host, allow that proxy's IP and configure TLS/authentication at the actual proxy.

## Credentials and provider privacy

Saved model API keys are server-side and write-only through settings APIs. An empty key field preserves a saved key; Clear key removes it. Protect the data volume and backups because they can contain credentials, conversations, and memory.

Self-hosting the Workbench does not mean every model request stays private. Hosted models, including free models, have their own logging and training policies. Check terms before sending secrets or confidential files. Private inference configuration is not a complete network air-gap.

## Two sandbox controls

| Setting | Controls |
| --- | --- |
| `AGENT_SANDBOX` | Hermes' own terminal backend |
| `JOBS_SANDBOX` | Whether delegated Jobs workers can run |

The installer defaults to direct Hermes commands with isolated Jobs workers. Isolating workers does not isolate every Hermes action. The Workbench Terminal shell remains in the agent container in every mode.

The Jobs sandbox is a separate privileged Docker-in-Docker service. Worker containers have limits and network restrictions, but the sandbox is not a guarantee that arbitrary code is harmless. Keep its management ports unpublished.

## Private network exceptions

Workers normally have internet access but cannot reach private network ranges. A LAN model server needs a narrowly scoped `SANDBOX_ALLOW_LAN` IP or CIDR exception applied through the deployment configuration. Saving an endpoint in the UI does not change the firewall. Worker `localhost` is the worker container.

For a Compose installation, the administrator sets `SANDBOX_ALLOW_LAN` in the deployment's `.env`; in Portainer, use the stack's environment variables. For example, allow only the model server's actual address rather than an entire LAN:

```env
SANDBOX_ALLOW_LAN=192.168.1.50/32
```

This is an example address, not a default. Applying deployment changes can recreate services and interrupt work; follow the planned deployment procedure in the [Deployment reference](#help/deployment-reference).

## Approvals are not interchangeable

Job plan approval, worker permission presets, browser chat modes, Policy Settings, and Hermes' own tool permissions control different execution paths. Do not assume a browser Plan/Ask setting restricts all gateway or CLI tools. Review the selected harness and deployment policy before delegating work.

See [Deployment reference](#help/deployment-reference) for the complete access and sandbox configuration, and [Models & connections](#help/connections) for endpoint settings.