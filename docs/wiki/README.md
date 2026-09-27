# Pending wiki patches

The [GitHub wiki](https://github.com/bentrd/GambonanzaMods/wiki) is a separate
git repository (`GambonanzaMods.wiki.git`) that repo-scoped automation cannot
always push to. Patches here are finished wiki commits waiting for someone
with wiki access to land them.

Apply and push them, oldest first, like this:

```bash
git clone https://github.com/bentrd/GambonanzaMods.wiki.git
cd GambonanzaMods.wiki
git am ../GambonanzaMods/docs/wiki/*.patch
git push
```

Each applies on its own too, so they can also land one at a time
(`git am ../GambonanzaMods/docs/wiki/0002-strain-api.patch`). Then delete the
applied patch files from this directory.
