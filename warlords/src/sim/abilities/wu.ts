// 吴 Wu ability implementations (wave 2). One module per hero under ./wu/;
// each calls registerAbility({ id: '<AbilityDef.id>', ... }) at import time.
// Tunables come from AbilityDef.params (data/heroes-wu.ts) with fallbacks.
import './wu/sunquan';
import './wu/ganning';
import './wu/lumeng';
import './wu/huanggai';
import './wu/zhouyu';
import './wu/daqiao';
import './wu/luxun';
import './wu/sunshangxiang';

export { FIRESHIP_FIELD } from './wu/huanggai';
export { LUXUN_FIELD } from './wu/luxun';
export { NAPALM_FIELD } from './wu/zhouyu';
