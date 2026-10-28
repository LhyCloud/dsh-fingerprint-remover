# Upload from the GitHub web UI (no git)

This folder is ready to publish as a repository. These steps use only a browser.

## 1. Create the repository

1. Open https://github.com/new.
2. Repository name: copy the `name` field from `package.json` and paste it.
   Do not retype it by hand.
3. Description: `Removes the dsh client fingerprints rejected by WorkBuddy with 400 / code 11-128.`
4. Choose Public.
5. Do not add a README, .gitignore, or license; this folder already has them.
6. Click Create repository.

## 2. Upload the files

1. On the empty repository page, click "uploading an existing file".
2. In Explorer, open the project folder and select the contents (Ctrl+A),
   not the folder itself.
3. Drag the selection into the browser upload area.
4. Wait until every file is listed, use the commit message
   `feat: initial release`, and click Commit changes.

Dragging the folder itself can create an extra top-level directory. If that
happens, delete the nested folder and upload its contents instead.

## 3. Dotfiles and hidden folders

Windows Explorer hides names starting with a dot by default. If these are
missing from the upload:

- .gitignore
- .gitattributes
- .github/workflows/test.yml

add them with Add file -> Create new file, using the exact path as the file
name (`/` creates folders). Paste the contents and commit.

## 4. Verify the tree

The repository root must contain:

```
.github/workflows/test.yml
.gitattributes
.gitignore
CHANGELOG.md
CONTRIBUTING.md
GITHUB-WEB-UPLOAD.md
LICENSE
README.md
SECURITY.md
cordis.patch.yml
lib/index.js
lib/sanitize.js
package-lock.json
package.json
test/fingerprint-remover.test.js
test/reference-rules.test.js
```

Do not upload node_modules/, *.tgz, or coverage/; .gitignore already excludes
them.

## 5. Enable Actions and check the badge

- Settings -> Actions -> General: allow actions for the repository.
- Open the Actions tab and confirm the `test` workflow runs.
- The README badge points at the current repository name. If your account or
  repository name differs, edit the badge URL and the repository / homepage /
  bugs fields in package.json.

## 6. Publish a release

1. Open Releases -> Draft a new release.
2. Tag: `v1.0.0`; title: `dsh-fingerprint-remover 1.0.0`.
3. Publish.

GitHub then serves:

```
https://github.com/<owner>/dsh-fingerprint-remover/archive/refs/tags/v1.0.0.tar.gz
https://github.com/<owner>/dsh-fingerprint-remover/archive/refs/tags/v1.0.0.zip
```

## 7. Install from GitHub

```
dsh plugin add github:<owner>/dsh-fingerprint-remover
```

or point the dsh plugin manager at the release tarball.