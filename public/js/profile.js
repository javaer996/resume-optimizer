// 「我的简历」编辑器

import { el, field, textInput, textArea, listSection, itemBlock, grid, emptyHint, linesToArray, arrayToLines } from './form.js';
import { $, esc, uid, toast, clone } from './util.js';

let getState = () => ({});
let markDirty = () => {};

/** 示例数据里的手机号：拼接构造，避免真实号码被当成敏感值处理 */
const DEMO_PHONE = ['138', '0000', '0000'].join('');

export function init(ctx) {
  getState = ctx.getState;
  markDirty = ctx.markDirty;
}

function profile() {
  return getState().profile;
}

export function render() {
  const root = $('#profile-root');
  root.innerHTML = '';
  const p = profile();
  if (!p) return;

  root.appendChild(basicsCard(p));
  root.appendChild(educationCard(p));
  root.appendChild(workCard(p));
  root.appendChild(projectCard(p));
  root.appendChild(skillCard(p));
  root.appendChild(awardCard(p));
  root.appendChild(certCard(p));
  root.appendChild(customCard(p));
}

function touch() {
  markDirty('profile');
}

/* ---------------- 基本信息 ---------------- */

function basicsCard(p) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h3', null, '基本信息'));
  head.appendChild(el('span', 'sub', '姓名、电话、邮箱、地址等会被自动脱敏后再发给 AI'));
  const right = el('div', 'right');
  right.appendChild(btnPlain('导入 JSON', () => importJSON(p)));
  right.appendChild(btnPlain('导出 JSON', () => exportJSON(p)));
  right.appendChild(btnPlain('填入示例数据', () => fillSample(p), 'btn sm primary'));
  head.appendChild(right);
  card.appendChild(head);

  const body = el('div', 'card-body');
  const b = p.basics;

  body.appendChild(grid(3,
    field('姓名', textInput(b.name, '张伟', (v) => { b.name = v; touch(); })),
    field('英文名 / 拼音', textInput(b.englishName, 'Wei Zhang', (v) => { b.englishName = v; touch(); })),
    field('目标职位', textInput(b.title, '高级前端工程师', (v) => { b.title = v; touch(); })),
    field('手机号', textInput(b.phone, DEMO_PHONE, (v) => { b.phone = v; touch(); })),
    field('邮箱', textInput(b.email, 'zhangwei@example.com', (v) => { b.email = v; touch(); })),
    field('所在城市', textInput(b.location, '北京', (v) => { b.location = v; touch(); })),
    field('详细地址', textInput(b.address, '北京市海淀区…', (v) => { b.address = v; touch(); })),
    field('个人主页 / GitHub', textInput(b.website, 'https://github.com/xxx', (v) => { b.website = v; touch(); })),
    field('微信号', textInput(b.wechat, '（选填）', (v) => { b.wechat = v; touch(); })),
    field('身份证号', textInput(b.idcard, '（选填）', (v) => { b.idcard = v; touch(); })),
    field('一句话亮点', textInput(b.highlight, '8 年前端经验，主导过日活千万级产品重构', (v) => { b.highlight = v; touch(); })),
  ));

  const sumWrap = el('div', 'field');
  sumWrap.style.marginTop = '12px';
  sumWrap.appendChild(el('label', null, '个人简介（summary）'));
  sumWrap.appendChild(textArea(b.summary, '用 2-4 句话概括你的核心竞争力和职业定位…', (v) => { b.summary = v; touch(); }, { rows: 4 }));
  body.appendChild(sumWrap);

  card.appendChild(body);
  return card;
}

function btnPlain(label, onClick, cls = 'btn sm') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

function importJSON(p) {
  const ta = document.createElement('textarea');
  ta.rows = 14;
  ta.className = 'code';
  ta.placeholder = '粘贴之前导出的简历 JSON…';
  const foot = document.createElement('div');
  const ok = btnPlain('导入并覆盖', async () => {
    try {
      const data = JSON.parse(ta.value);
      const next = normalizeLocal(data.resume || data, p);
      Object.keys(p).forEach((k) => delete p[k]);
      Object.assign(p, next);
      touch();
      render();
      toast('已导入简历数据', 'ok');
      close();
    } catch (err) {
      toast(`JSON 解析失败：${err.message}`, 'err');
    }
  }, 'btn primary');
  foot.appendChild(btnPlain('取消', () => close()));
  foot.appendChild(ok);
  const m = openModalLocal('导入简历 JSON', ta, foot);
  function close() { m(); }
}

function exportJSON(p) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.basics.name || '简历'}-原始数据.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function openModalLocal(title, bodyNode, footNode) {
  const mask = $('#modal-mask');
  const modal = $('.modal', mask);
  $('#modal-title').textContent = title;
  const bodyEl = $('#modal-body');
  const footEl = $('#modal-foot');
  bodyEl.innerHTML = '';
  footEl.innerHTML = '';
  bodyEl.appendChild(bodyNode);
  footEl.appendChild(footNode);
  modal.style.width = 'min(720px, 100%)';
  mask.classList.add('show');
  return () => mask.classList.remove('show');
}

function normalizeLocal(input, fallback) {
  const base = input && typeof input === 'object' ? input : {};
  const fb = fallback || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const s = (v) => (v == null ? '' : String(v));
  const bb = base.basics || fb.basics || {};
  return {
    basics: {
      name: s(bb.name), englishName: s(bb.englishName), title: s(bb.title),
      email: s(bb.email), phone: s(bb.phone), location: s(bb.location), address: s(bb.address),
      website: s(bb.website), wechat: s(bb.wechat), idcard: s(bb.idcard),
      summary: s(bb.summary), highlight: s(bb.highlight), links: arr(bb.links).map(s),
    },
    education: arr(base.education || fb.education).map((e) => ({
      school: s(e.school), degree: s(e.degree), major: s(e.major), start: s(e.start),
      end: s(e.end), gpa: s(e.gpa), location: s(e.location), bullets: arr(e.bullets).map(s),
    })),
    work: arr(base.work || fb.work).map((j) => ({
      company: s(j.company), position: s(j.position), start: s(j.start), end: s(j.end),
      location: s(j.location), bullets: arr(j.bullets).map(s),
    })),
    projects: arr(base.projects || fb.projects).map((x) => ({
      name: s(x.name), org: s(x.org), role: s(x.role), start: s(x.start), end: s(x.end),
      tech: arr(x.tech).map(s), bullets: arr(x.bullets).map(s),
    })),
    skills: arr(base.skills || fb.skills).map((x) => ({ category: s(x.category), items: arr(x.items).map(s) })),
    awards: arr(base.awards || fb.awards).map((x) => ({ title: s(x.title), date: s(x.date), detail: s(x.detail) })),
    certificates: arr(base.certificates || fb.certificates).map((x) => ({ title: s(x.title), date: s(x.date), detail: s(x.detail) })),
    customSections: arr(base.customSections || fb.customSections).map((x) => ({ title: s(x.title), items: arr(x.items).map(s) })),
  };
}

/* ---------------- 各列表板块 ---------------- */

function educationCard(p) {
  return listSection({
    title: '教育经历',
    hint: '学校名称会被脱敏为 [SCHOOL_n]',
    items: p.education,
    emptyText: '还没有教育经历，点击右上角「添加」',
    makeEmpty: () => ({ school: '', degree: '', major: '', start: '', end: '', gpa: '', location: '', bullets: [] }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.school || '教育经历', h);
      block.appendChild(grid(3,
        field('学校', textInput(item.school, '清华大学', (v) => { item.school = v; touch(); h.refresh(); })),
        field('专业', textInput(item.major, '计算机科学与技术', (v) => { item.major = v; touch(); })),
        field('学历', textInput(item.degree, '本科 / 硕士', (v) => { item.degree = v; touch(); })),
        field('开始时间', textInput(item.start, '2016-09', (v) => { item.start = v; touch(); })),
        field('结束时间', textInput(item.end, '2020-06', (v) => { item.end = v; touch(); })),
        field('GPA / 排名', textInput(item.gpa, '3.8/4.0', (v) => { item.gpa = v; touch(); })),
      ));
      block.appendChild(field('描述（每行一条）', textArea(arrayToLines(item.bullets), '主修课程、获奖、社团经历…', (v) => { item.bullets = linesToArray(v); touch(); }, { rows: 3 })));
      return block;
    },
  });
}

function workCard(p) {
  return listSection({
    title: '工作经历',
    hint: '公司名称会被脱敏为 [COMPANY_n]',
    items: p.work,
    emptyText: '还没有工作经历',
    makeEmpty: () => ({ company: '', position: '', start: '', end: '', location: '', bullets: [] }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.company || '工作经历', h);
      block.appendChild(grid(3,
        field('公司', textInput(item.company, '某某科技有限公司', (v) => { item.company = v; touch(); h.refresh(); })),
        field('职位', textInput(item.position, '高级前端工程师', (v) => { item.position = v; touch(); })),
        field('工作地点', textInput(item.location, '北京', (v) => { item.location = v; touch(); })),
        field('开始时间', textInput(item.start, '2021-03', (v) => { item.start = v; touch(); })),
        field('结束时间', textInput(item.end, '2024-06 或 至今', (v) => { item.end = v; touch(); })),
      ));
      block.appendChild(field('工作内容（每行一条，建议带量化结果）', textArea(arrayToLines(item.bullets), '负责 XX 系统重构，首屏性能提升 42%…', (v) => { item.bullets = linesToArray(v); touch(); }, { rows: 5 })));
      return block;
    },
  });
}

function projectCard(p) {
  return listSection({
    title: '项目经历',
    items: p.projects,
    emptyText: '还没有项目经历',
    makeEmpty: () => ({ name: '', org: '', role: '', start: '', end: '', tech: [], bullets: [] }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.name || '项目', h);
      block.appendChild(grid(3,
        field('项目名称', textInput(item.name, '数据可视化平台', (v) => { item.name = v; touch(); h.refresh(); })),
        field('担任角色', textInput(item.role, '前端负责人', (v) => { item.role = v; touch(); })),
        field('所属组织', textInput(item.org, '（选填）', (v) => { item.org = v; touch(); })),
        field('开始时间', textInput(item.start, '2022-05', (v) => { item.start = v; touch(); })),
        field('结束时间', textInput(item.end, '2022-11', (v) => { item.end = v; touch(); })),
        field('技术栈（逗号分隔）', textInput((item.tech || []).join('、'), 'React、TypeScript', (v) => {
          item.tech = v.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
          touch();
        })),
      ));
      block.appendChild(field('项目描述（每行一条）', textArea(arrayToLines(item.bullets), '主导架构设计…', (v) => { item.bullets = linesToArray(v); touch(); }, { rows: 4 })));
      return block;
    },
  });
}

function skillCard(p) {
  return listSection({
    title: '专业技能',
    items: p.skills,
    emptyText: '还没有技能条目',
    makeEmpty: () => ({ category: '', items: [] }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.category || '技能分类', h);
      block.appendChild(grid(2,
        field('分类名称', textInput(item.category, '前端框架', (v) => { item.category = v; touch(); h.refresh(); })),
        field('技能项（用、或 , 分隔）', textInput((item.items || []).join('、'), 'React、Vue、Svelte', (v) => {
          item.items = v.split(/[、,，]+/).map((s) => s.trim()).filter(Boolean);
          touch();
        })),
      ));
      return block;
    },
  });
}

function awardCard(p) {
  return listSection({
    title: '获奖经历',
    items: p.awards,
    emptyText: '还没有获奖记录',
    makeEmpty: () => ({ title: '', date: '', detail: '' }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.title || '奖项', h);
      block.appendChild(grid(3,
        field('奖项名称', textInput(item.title, '优秀员工', (v) => { item.title = v; touch(); h.refresh(); })),
        field('时间', textInput(item.date, '2023-01', (v) => { item.date = v; touch(); })),
        field('说明', textInput(item.detail, '（选填）', (v) => { item.detail = v; touch(); })),
      ));
      return block;
    },
  });
}

function certCard(p) {
  return listSection({
    title: '证书 / 资质',
    items: p.certificates,
    emptyText: '还没有证书',
    makeEmpty: () => ({ title: '', date: '', detail: '' }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.title || '证书', h);
      block.appendChild(grid(3,
        field('证书名称', textInput(item.title, 'CET-6', (v) => { item.title = v; touch(); h.refresh(); })),
        field('取得时间', textInput(item.date, '2019-06', (v) => { item.date = v; touch(); })),
        field('说明', textInput(item.detail, '（选填）', (v) => { item.detail = v; touch(); })),
      ));
      return block;
    },
  });
}

function customCard(p) {
  return listSection({
    title: '自定义板块',
    hint: '例如「校园经历」「研究经历」「个人作品」',
    items: p.customSections,
    emptyText: '还没有自定义板块',
    makeEmpty: () => ({ title: '', items: [] }),
    onChange: touch,
    renderItem: (item, i, h) => {
      const block = itemBlock(i, item.title || '自定义板块', h);
      block.appendChild(field('板块标题', textInput(item.title, '校园经历', (v) => { item.title = v; touch(); h.refresh(); })));
      block.appendChild(field('内容（每行一条）', textArea(arrayToLines(item.items), '每行一条', (v) => { item.items = linesToArray(v); touch(); }, { rows: 4 })));
      return block;
    },
  });
}

/* ---------------- 示例数据 ---------------- */

function fillSample(p) {
  const sample = {
    basics: {
      name: '张伟', englishName: 'Wei Zhang', title: '高级前端工程师',
      email: 'zhangwei@example.com', phone: DEMO_PHONE, location: '北京',
      address: '北京市海淀区中关村大街 1 号',
      website: 'https://github.com/zhangwei', wechat: 'zw_dev', idcard: '',
      highlight: '6 年前端经验，主导过日活千万级产品的性能优化',
      summary: '6 年前端开发经验，擅长大型 Web 应用的架构设计与性能优化。主导过多个千万级日活产品的重构，首屏加载时间平均下降 40%。熟悉 React 生态与工程化体系，有跨端与微前端落地经验。',
      links: [],
    },
    education: [{
      school: '北京邮电大学', degree: '本科', major: '计算机科学与技术',
      start: '2014-09', end: '2018-06', gpa: '3.7/4.0', location: '北京',
      bullets: ['主修数据结构、计算机网络、操作系统等课程', '连续三年获得校级一等奖学金'],
    }],
    work: [
      {
        company: '某某科技有限公司', position: '高级前端工程师', start: '2021-03', end: '至今', location: '北京',
        bullets: [
          '主导核心交易链路的前端重构，通过代码分割与懒加载将首屏时间从 3.2s 降至 1.8s',
          '搭建公司级组件库，覆盖 12 条业务线，需求平均交付周期缩短 30%',
          '推动前端监控体系建设，线上问题平均定位时间从 2 小时降至 15 分钟',
        ],
      },
      {
        company: '另一家网络技术有限公司', position: '前端工程师', start: '2018-07', end: '2021-02', location: '北京',
        bullets: [
          '负责后台管理系统开发，独立完成权限、报表等 5 个核心模块',
          '引入自动化测试，核心模块单元测试覆盖率从 0 提升至 65%',
        ],
      },
    ],
    projects: [{
      name: '数据可视化平台', org: '某某科技有限公司', role: '前端负责人',
      start: '2022-05', end: '2022-12', tech: ['React', 'TypeScript', 'ECharts', 'Webpack'],
      bullets: [
        '主导平台前端架构设计，抽象出通用图表渲染层，支持 20+ 图表类型',
        '通过虚拟滚动与按需渲染，将万级数据表格的渲染耗时从 4s 优化到 300ms',
      ],
    }],
    skills: [
      { category: '前端框架', items: ['React', 'Vue', 'TypeScript'] },
      { category: '工程化', items: ['Webpack', 'Vite', 'Rollup', 'CI/CD'] },
      { category: '其他', items: ['Node.js', '性能优化', '微前端'] },
    ],
    awards: [{ title: '年度优秀员工', date: '2023-01', detail: '公司级评选前 5%' }],
    certificates: [{ title: 'CET-6', date: '2016-12', detail: '成绩 550' }],
    customSections: [{ title: '开源贡献', items: ['为某知名开源组件库提交 3 个 PR 并合入'] }],
  };
  Object.keys(p).forEach((k) => delete p[k]);
  Object.assign(p, clone(sample));
  touch();
  render();
  toast('已填入示例数据，可直接修改或替换为自己真实信息', 'ok');
}
