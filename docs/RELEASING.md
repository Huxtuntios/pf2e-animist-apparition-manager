# Publishing a release

A release is a GitHub release whose tag matches the version in `module.json`. When it is published, `.github/workflows/release.yml` checks the module, builds `module.json` (with the URLs filled in) and `module.zip`, and attaches both to the release. Foundry installs from those two files.

## Steps

1. Change `version` in `module.json` and in `package.json` to the same new number (for example `1.2.0`).
2. Run `npm test` and commit the change to `main`.
3. On GitHub open **Releases → Draft a new release**.
4. In **Choose a tag** type `v` plus the version (`v1.2.0`) and pick **Create new tag on publish**; the target is `main`.
5. Give the release a title (`1.2.0`), write the notes, and press **Publish release**.
6. Open the **Actions** tab and wait for the **Release** run to turn green. The release page then shows `module.json` and `module.zip` under **Assets**.

## Check the result

- `https://github.com/Huxtuntios/pf2e-animist-apparition-manager/releases/latest/download/module.json` opens the manifest, and its `download` field points to `.../releases/download/v1.2.0/module.zip`.
- In Foundry, **Add-on Modules → Install Module**, paste the manifest URL above and press **Install**.

## If something goes wrong

- The run fails with "tag ... does not match the module.json version": the tag and the version differ. Fix the version, delete the release and its tag, and publish again.
- The run fails in `npm test`: run it locally and fix what it reports. Nothing is attached to the release until the run succeeds.
- To rebuild the assets of an existing release, open the failed run in **Actions** and choose **Re-run all jobs**; files that were already uploaded are replaced.
