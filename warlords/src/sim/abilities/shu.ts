// 蜀 Shu ability implementations — entry point imported by abilities/index.ts.
// One module per hero under ./shu/ (each calls registerAbility() / registerHazardKind()
// at import time); shared helpers live in ./shu/util.ts.
//
//   刘备 liubei        仁德 · 仁德·济民 · 蜀汉旌旗 · 激将 (lord)
//   关羽 guanyu        武圣 · 青龙斩 · 义绝                 (wave-1 reference, reviewed)
//   张飞 zhangfei      蛇矛连击 · 咆哮 · 据水断桥
//   诸葛亮 zhugeliang  观星 · 八阵图 · 空城
//   赵云 zhaoyun       龙胆 · 七进七出 · 长坂救主
//   马超 machao        马术 · 铁骑 · 西凉冲锋
//   黄月英 huangyueying 集智 · 木牛流马 · 奇才
//   黄忠 huangzhong    烈弓 · 百步穿杨 · 老当益壮
//
// Pattern: read tunables from AbilityDef.params (with fallbacks), use common.ts
// helpers, return true from activate() only when the ability actually fired.
import './shu/liubei';
import './shu/guanyu';
import './shu/zhangfei';
import './shu/zhugeliang';
import './shu/zhaoyun';
import './shu/machao';
import './shu/huangyueying';
import './shu/huangzhong';

