# Gameplay hooks

## Before a loss (framework 1.8.0+)

The optional `Gambonanza.ModSdk.IModLossHooks` interface lets an enabled mod
intercept `GameManager.Lose()` before the game records loss statistics, sets
`m_HasLost`, changes the loss state, or erases the saved run. Obtain the interface
from the context passed to `IMod.OnLoad`:

```csharp
IModLossHooks hooks = ctx as IModLossHooks;
```

`OnBeforeLose` is an event of type `Func<MonoBehaviour, bool>`. Its argument is
the `GameManager` instance whose `Lose()` method was called. Returning `false`
allows dispatch to continue. Returning `true` cancels that call to the vanilla
`Lose()` method; the remaining callbacks are skipped, including callbacks in
other mods. The first callback to return `true` wins.

Only enabled mods receive the event. Each callback runs synchronously. If a
callback throws, ModHost logs the exception and continues with the remaining
callbacks. If none returns `true`, vanilla `Lose()` runs normally.

A recursive `Lose()` call on the same manager during hook dispatch is
suppressed. A later call, including one made by a delayed coroutine, dispatches
the hooks again. Mods that consume a one-shot rescue must account for those
later calls as part of their own recovery logic.

### What cancellation covers

This hook runs at the beginning of `Lose()`, rather than at the beginning of a
lethal move. An enemy capture, a fall, or preparation of the loss UI may already
have happened before the game calls `Lose()`.

Returning `true` only skips `Lose()`. It does not win the stage, revive a piece,
restore the board, stop pending coroutines, remove enemies, or reset buttons.
A mod implementing a rescue must handle those transitions itself. Calling
`Win()` from a capture notification is not a complete recovery: the capture
coroutine can still resume and continue changing game state.

### Subscription example

This entry class demonstrates an opt-in, one-shot cancellation and reversible
event subscription. Its flag stays off until the mod's own gameplay code calls
`ArmAfterPreparingRecovery()`. That gameplay code must already arrange a valid
recovery; this example is not a complete extra-life mod.

```csharp
using Gambonanza.ModSdk;
using UnityEngine;

namespace LossHookExample
{
    public sealed class Entry : IMod, IModLifecycle
    {
        private IModLossHooks _hooks;
        private bool _subscribed;
        private bool _cancelNextLoss;

        public void OnLoad(IModContext ctx)
        {
            _hooks = ctx as IModLossHooks;
            if (_hooks == null)
                ctx.LogLine("Loss hooks require an updated ModHost.");
        }

        public void OnEnable()
        {
            if (_hooks == null || _subscribed) return;
            _hooks.OnBeforeLose += BeforeLose;
            _subscribed = true;
        }

        public void OnDisable()
        {
            if (_hooks != null && _subscribed)
                _hooks.OnBeforeLose -= BeforeLose;
            _subscribed = false;
            _cancelNextLoss = false;
        }

        // Call only when this mod has arranged its own recovery transition.
        public void ArmAfterPreparingRecovery()
        {
            if (_subscribed) _cancelNextLoss = true;
        }

        private bool BeforeLose(MonoBehaviour gameManager)
        {
            if (!_cancelNextLoss) return false;
            _cancelNextLoss = false;
            return true;
        }
    }
}
```

The example consumes its flag before returning `true`, so a later loss attempt
is allowed through. A real rescue may need to reject duplicate loss attempts
until its transition finishes and persist any consumed charge in the run save.

### Installation and compatibility

The hook requires framework 1.8.0 or newer. Install the framework update through
the Mod Manager and re-patch the game, or rebuild ModSdk, ModHost and the patcher,
install the new framework DLLs, and repatch the game's `Assembly-CSharp.dll`.
Replacing a mod DLL alone does not add the new call
site. From this repository, `./build.sh` builds and installs the framework and
repatches the local game; an explicit game path can be passed as its argument.

`IModContext` is unchanged. The hook lives in a separate optional interface to
preserve the existing context ABI: existing `IModContext` implementations and
older mods remain compatible with the new SDK and host. Mods using this hook
require the updated ModSdk at both build time and runtime; an old installed SDK
does not define `IModLossHooks`, so the cast cannot provide a fallback there.
With the updated SDK available, a null cast detects an older or custom context
implementation that does not expose loss hooks. A successful cast does not
certify that the installed `Assembly-CSharp.dll` has the new loss hook.

Framework hook checks run with:

```bash
dotnet run --project tests/FrameworkHooks.Tests -c Release
```

These checks verify hook dispatch and the injected loss call site. Gameplay
recovery still needs in-game testing for the specific mod.
