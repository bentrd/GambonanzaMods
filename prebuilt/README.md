# prebuilt/

The compiled framework DLLs, committed so that release CI (which cannot build
against the game's copyrighted assemblies) can package them. Refresh with:

    ./build.sh --skip-samples
    tools/package-framework.sh --stage-prebuilt

Built from this repository's MIT-licensed sources at the commit that changed
them; they contain no game code.
