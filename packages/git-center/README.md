# git-center

Show the active Git repository, branch, and working-tree status in the status bar.

Ahead and behind counts compare local refs only; nothing here fetches on your behalf, so they move when you do.

## Features

- **Repository tile**: shows the window's active repository and how many files are added, modified, deleted, or conflicted, or the focused folder dimmed when it is not part of a repository; choosing a repository locks it, while `Auto` follows the active workspace item.
- **Branch tile**: shows the active repository's branch and how far it has drifted from its upstream, and offers branch creation, start-point selection, and detached checkout; its picker groups local branches, remote branches, and tags with each ref's latest commit author, age, short hash, and subject.
- **Filterable pickers**: clicking a tile opens a list for switching repositories or checking out branches, with working-tree counts and upstream drift on the rows that have them.
- **Quick switching**: the mouse wheel over the repository tile cycles through repositories, middle click locks or unlocks the current selection, and the repository picker's rescan item scans the project roots again.

## Commands

Commands available in `atom-workspace`:

- `git-center:select-repository`: pick the active repository,
- `git-center:select-branch`: pick a branch of the active repository to check out,
- `git-center:toggle-lock`: pin or unpin the active repository so it stops or resumes following the active editor.

## Services

- **status-bar** (`^1.0.0`): consumed to display the repository and branch tiles.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
