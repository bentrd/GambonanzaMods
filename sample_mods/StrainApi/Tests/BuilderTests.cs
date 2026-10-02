using NUnit.Framework;

namespace Gambonanza.StrainApi.Tests
{
    public sealed class BuilderTests
    {
        [Test]
        public void ExistingStrainsKeepTheirDefaultCategoryAndHeat()
        {
            var strain = StrainBuilder.Create("existing").Build();
            Assert.That(strain.IsBonus, Is.False);
            Assert.That(strain.Heat, Is.EqualTo(1));
        }

        [Test]
        public void ZeroHeatAloneDoesNotChangeTheCategory()
        {
            var strain = StrainBuilder.Create("neutral").WithHeat(0).Build();
            Assert.That(strain.IsBonus, Is.False);
            Assert.That(strain.Heat, Is.Zero);
        }

        [Test]
        public void BonusesHaveZeroHeatRegardlessOfBuilderOrder()
        {
            var before = StrainBuilder.Create("before").WithHeat(4).AsBonus().Build();
            var after = StrainBuilder.Create("after").AsBonus().WithHeat(4).Build();
            Assert.That(before.IsBonus, Is.True);
            Assert.That(after.IsBonus, Is.True);
            Assert.That(before.Heat, Is.Zero);
            Assert.That(after.Heat, Is.Zero);
        }

        [Test]
        public void BonusMetadataAndConflictsKeepTheirIds()
        {
            var bonus = StrainBuilder.Create("cashback").WithName("Cashback")
                .WithDescription("An expiry payout.").AsBonus().IncompatibleWith("other").Build();
            var other = StrainBuilder.Create("other").Build();
            Assert.That(bonus.Id, Is.EqualTo("cashback"));
            Assert.That(bonus.Name, Is.EqualTo("Cashback"));
            Assert.That(bonus.Description, Is.EqualTo("An expiry payout."));
            Assert.That(bonus.ConflictsWith(other), Is.True);
            Assert.That(other.ConflictsWith(bonus), Is.True);
        }
    }
}
