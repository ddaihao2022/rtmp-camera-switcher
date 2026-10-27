/**
 * 项目名显示：只有在项目名本身没有组别/性别信息时，才补「男子/女子/混合」前缀。
 *
 * 秩序册里的项目名有两种写法：
 *   · 「100米」+ 类别「男子」      → 显示「男子100米」
 *   · 「小四、五男子实心球」+ 类别「男子」→ 不能再补，否则会变成「男子小四、五男子实心球」
 */
const HAS_GROUP = /(男子|女子|男、女|男女|混合|小学|初中|高中|初一|初二|高一|高二|教职工|小四|小五|小六|焦)/;

export function eventDisplayName(eventName, category) {
  const name = String(eventName || '').trim();
  const cat = String(category || '').trim();
  if (!name) return cat || '未设置项目';
  if (!cat || HAS_GROUP.test(name)) return name;
  return `${cat}${name}`;
}
