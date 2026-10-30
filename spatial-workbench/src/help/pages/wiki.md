## Read and edit notes

Open **Wiki**, choose a Markdown page, and use **View** to read the rendered document. Switch to **Edit** to change the source, then **Save**. Editing is not saved until you choose Save.

The wiki consists of ordinary files in the configured wiki directory. It does not require Obsidian or an Obsidian account.

## Connect pages

Use double-bracket links in Markdown:

```markdown
[[Model setup]]
[[Model setup|Connection notes]]
```

In View mode, a resolved link opens that wiki page. An alias changes the label. A link to a page that cannot be found reports an error; it does not automatically create a new note. Links inside code blocks remain examples, not navigation.

## Find and move information

Use the wiki search controls to find matching notes. Uploads are stored on the agent host. Download a file or a folder ZIP when you need a local copy; check that private notes are not included before sharing.

If the wiki appears empty, check the configured wiki path and the workspace volume. Existing notes on your desktop are not automatically available inside the container.

## Preserve useful context

Keep durable research, decisions, and references in the wiki rather than relying on a single chat transcript. Agent skills and memory are managed separately in [Sessions, skills & memory](#help/sessions).