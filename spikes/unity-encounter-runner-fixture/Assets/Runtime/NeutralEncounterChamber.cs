using UnityEngine;

namespace MythMaker.NeutralEncounterRunner
{
    /// <summary>A disposable neutral chamber: two non-host actors exchange scripted damage.</summary>
    public sealed class NeutralEncounterChamber : MonoBehaviour
    {
        public int PlayerHitPoints { get; private set; } = 20;
        public int TargetHitPoints { get; private set; } = 20;
        public bool PlayerHitObserved { get; private set; }
        public bool TargetHitObserved { get; private set; }

        public void RunScriptedExchange()
        {
            TargetHitPoints -= 9;
            TargetHitObserved = true;
            Debug.Log("MYTH_MAKER_HIT actor=player target=encounter-target damage=9");
            PlayerHitPoints -= 4;
            PlayerHitObserved = true;
            Debug.Log("MYTH_MAKER_HIT actor=encounter-target target=player damage=4");
        }
    }
}
