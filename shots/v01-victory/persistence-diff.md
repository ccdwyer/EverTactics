# v0.1 victory persistence diff

Source: before refresh `11-world-map-before-refresh.png`; immediate post-refresh `12-reload.png`.

Whole-save SHA-256: `6927f35b30920215532ea67133a6fb6957c55f7043a5514ed13ba5bd3e46b7d8` before and after; 4999 bytes before and after.

| Scope | Field | Before refresh | After refresh | Identical |
|---|---|---|---|---|
| campaign | gil | `490` | `490` | yes |
| campaign | progress.completed | `["battle-open"]` | `["battle-open"]` | yes |
| campaign | progress.current | `"battle-open"` | `"battle-open"` | yes |
| campaign | inventory | `{"long-sword":1,"rod":1,"buckler":1,"use-potion":3,"use-antidote":1}` | `{"long-sword":1,"rod":1,"buckler":1,"use-potion":3,"use-antidote":1}` | yes |
| p-aldric | level | `14` | `14` | yes |
| p-aldric | exp | `95` | `95` | yes |
| p-aldric | currentJob | `"knight"` | `"knight"` | yes |
| p-aldric | jobs.knight.level | `6` | `6` | yes |
| p-aldric | jobs.knight.jp | `1442` | `1442` | yes |
| p-aldric | jobs.knight.totalJp | `1442` | `1442` | yes |
| p-aldric | jobs.knight.learned | `"21 ids; sha256 97d4de7bf9bfed77"` | `"21 ids; sha256 97d4de7bf9bfed77"` | yes |
| p-aldric | equipment | `{"rightHand":"broadsword","leftHand":"buckler","head":"bronze-helm","body":"chain-mail","accessory":"bracer"}` | `{"rightHand":"broadsword","leftHand":"buckler","head":"bronze-helm","body":"chain-mail","accessory":"bracer"}` | yes |
| p-seryn | level | `13` | `13` | yes |
| p-seryn | exp | `36` | `36` | yes |
| p-seryn | currentJob | `"white-mage"` | `"white-mage"` | yes |
| p-seryn | jobs.white-mage.level | `6` | `6` | yes |
| p-seryn | jobs.white-mage.jp | `1325` | `1325` | yes |
| p-seryn | jobs.white-mage.totalJp | `1325` | `1325` | yes |
| p-seryn | jobs.white-mage.learned | `"29 ids; sha256 bf40a749da057a0f"` | `"29 ids; sha256 bf40a749da057a0f"` | yes |
| p-seryn | equipment | `{"rightHand":"white-staff","head":"feather-hat","body":"linen-robe","accessory":"bracer"}` | `{"rightHand":"white-staff","head":"feather-hat","body":"linen-robe","accessory":"bracer"}` | yes |
| p-belric | level | `14` | `14` | yes |
| p-belric | exp | `95` | `95` | yes |
| p-belric | currentJob | `"archer"` | `"archer"` | yes |
| p-belric | jobs.archer.level | `6` | `6` | yes |
| p-belric | jobs.archer.jp | `1395` | `1395` | yes |
| p-belric | jobs.archer.totalJp | `1395` | `1395` | yes |
| p-belric | jobs.archer.learned | `"19 ids; sha256 c169fe81adc7f7d2"` | `"19 ids; sha256 c169fe81adc7f7d2"` | yes |
| p-belric | equipment | `{"rightHand":"long-bow","head":"green-beret","body":"leather-outfit","accessory":"spike-shoes"}` | `{"rightHand":"long-bow","head":"green-beret","body":"leather-outfit","accessory":"spike-shoes"}` | yes |
| p-ivane | level | `13` | `13` | yes |
| p-ivane | exp | `55` | `55` | yes |
| p-ivane | currentJob | `"black-mage"` | `"black-mage"` | yes |
| p-ivane | jobs.black-mage.level | `6` | `6` | yes |
| p-ivane | jobs.black-mage.jp | `1332` | `1332` | yes |
| p-ivane | jobs.black-mage.totalJp | `1332` | `1332` | yes |
| p-ivane | jobs.black-mage.learned | `"29 ids; sha256 a3b47a2e74834d4d"` | `"29 ids; sha256 a3b47a2e74834d4d"` | yes |
| p-ivane | equipment | `{"rightHand":"flame-rod","head":"feather-hat","body":"silk-robe","accessory":"battle-boots"}` | `{"rightHand":"flame-rod","head":"feather-hat","body":"silk-robe","accessory":"battle-boots"}` | yes |
| p-torvald | level | `14` | `14` | yes |
| p-torvald | exp | `75` | `75` | yes |
| p-torvald | currentJob | `"monk"` | `"monk"` | yes |
| p-torvald | jobs.monk.level | `6` | `6` | yes |
| p-torvald | jobs.monk.jp | `1432` | `1432` | yes |
| p-torvald | jobs.monk.totalJp | `1432` | `1432` | yes |
| p-torvald | jobs.monk.learned | `"19 ids; sha256 2eebc83b7a9ad4e8"` | `"19 ids; sha256 2eebc83b7a9ad4e8"` | yes |
| p-torvald | equipment | `{"head":"headband","body":"leather-outfit","accessory":"bracer"}` | `{"head":"headband","body":"leather-outfit","accessory":"bracer"}` | yes |
| p-nessa | level | `13` | `13` | yes |
| p-nessa | exp | `80` | `80` | yes |
| p-nessa | currentJob | `"thief"` | `"thief"` | yes |
| p-nessa | jobs.thief.level | `6` | `6` | yes |
| p-nessa | jobs.thief.jp | `1295` | `1295` | yes |
| p-nessa | jobs.thief.totalJp | `1295` | `1295` | yes |
| p-nessa | jobs.thief.learned | `"16 ids; sha256 be4288b3ee4a0b67"` | `"16 ids; sha256 be4288b3ee4a0b67"` | yes |
| p-nessa | equipment | `{"rightHand":"mythril-knife","head":"green-beret","body":"leather-outfit","accessory":"battle-boots"}` | `{"rightHand":"mythril-knife","head":"green-beret","body":"leather-outfit","accessory":"battle-boots"}` | yes |

Compared 52 requested field rows; mismatches: 0.
