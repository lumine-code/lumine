# git-center

Show the active Git repository, branch, and working-tree status in the status bar.

## Features

- **Repository tile**: shows the window's active repository and how many files are added, modified, deleted, or conflicted, or the focused folder dimmed when it is not part of a repository; choosing a repository locks it, while `Auto` follows the active workspace item.
- **Branch tile**: shows the active repository's branch and how far it has drifted from its upstream, and offers branch creation, start-point selection, and detached checkout; reads "No repository" outside every repository.
- **Filterable pickers**: clicking a tile opens a list for switching repositories or checking out branches, each row carrying its own status and upstream detail.
- **Quick switching**: the mouse wheel over the repository tile cycles through repositories, and middle click locks or unlocks the current selection.

Ahead and behind counts compare local refs only; nothing here fetches on your behalf, so they move when you do.

## Commands

Commands available in `atom-workspace`:

- `git-center:select-repository`: pick the active repository,
- `git-center:select-branch`: pick a branch of the active repository to check out,
- `git-center:toggle-lock`: pin or unpin the active repository so it stops or resumes following the active editor.

## Services

- **[status-bar](https://lumine-code.github.io/docs.html#services/status-bar)** (`^1.0.0`): consumed to display the repository and branch tiles.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
