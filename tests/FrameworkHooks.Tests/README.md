Run from the repository root:

```sh
dotnet run --project tests/FrameworkHooks.Tests -c Release
```

The harness compiles the production SDK, context, registry and host with minimal
stand-ins for Unity and unrelated services. It checks subscription order,
exception isolation, enabled-mod routing, optional-interface compatibility and
recursive loss handling.

It also builds synthetic Unity/game/runtime assemblies with Cecil, runs the real
patcher as a process, and executes the patched `Lose` method in an isolated load
context. Those checks prove that cancellation precedes every loss effect, allowing
loss preserves their order, reinstalling adds only one hook, and an absent or
incompatible target aborts without rewriting the game assembly. No game files are
needed or distributed. These tests do not replace an in-game rescue mod test.
