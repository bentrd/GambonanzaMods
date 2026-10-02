# Strain Creation API

Build run modifiers with `StrainBuilder`; reference `Gambonanza.StrainApi.dll`
and list `StrainApi` in your mod's dependencies. Register in `OnEnable` and
unregister in `OnDisable`.

Version **1.1.0** adds bonus strains:

```csharp
StrainBuilder.Create("cashback")
    .WithName("Cashback")
    .WithDescription("Expiring gambits pay their <color=*>sell value</color>.")
    .AsBonus()
    .WithGameIcon("SPR_Lucky_Coin")
    .WithBehaviour<CashbackBehaviour>()
    .Register();
```

`.AsBonus()` sets `StrainDefinition.IsBonus` and keeps its heat at zero,
regardless of the order of builder calls. Ordinary strains use `.WithHeat()`
as before.

On the Custom screen, the arrows by **STRAINS** open mod pages. The vanilla
page shows the game's own strains and bonuses. Mod pages show mod strains
and a separate column of mod bonuses, using the game's native bonus cards.
Each page holds up to 15 strains and 4 bonuses. The bulk strain and bonus
buttons select their respective categories.

Selections are recorded with a Custom run and restored on Continue. Preset
difficulties keep their fixed modifiers. For development, `strain apply <id>`
and `strain remove <id>` change the current run; `strain on <id>` and
`strain off <id>` change the next Custom run's selection.

Use builder hooks for simple effects or `StrainBehaviour` for stateful
effects. Its instance stays alive for the run, including shops and win
screens, and is destroyed when the run is left. Start-only hooks are not
repeated when a saved run is continued.
