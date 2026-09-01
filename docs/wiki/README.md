# Pending wiki patches

The [GitHub wiki](https://github.com/bentrd/GambonanzaMods/wiki) is a separate
git repository (`GambonanzaMods.wiki.git`) that repo-scoped automation cannot
always push to. Patches here are finished wiki commits waiting for someone
with wiki access to land them.

Apply and push one like this:

```bash
git clone https://github.com/bentrd/GambonanzaMods.wiki.git
cd GambonanzaMods.wiki
git am ../GambonanzaMods/docs/wiki/0001-gambit-ui-explanation-flags.patch
git push
```

Then delete the applied patch file from this directory.
