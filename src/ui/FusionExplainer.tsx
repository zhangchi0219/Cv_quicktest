// Left-pane teaching copy for the deuterium–tritium fusion scene. Split into two
// parts: FusionPrinciple (核聚变原理 + 意义 + 方程/质量亏损/库仑势垒 — shown on the
// intro page) and FusionInteraction (the demo page, framed as a gallery
// interactive exhibit: 动手引导 + 精简操作 + 一段串联托卡马克/中国人造太阳/下一展项引子).
// zh-CN per project convention.
export function FusionPrinciple() {
  return (
    <>
      <h3>核聚变原理</h3>
      <p>
        把两个<strong>轻原子核</strong>推到足够近，它们会<strong>融合</strong>
        成一个更重的核，并释放出巨大的能量 —— 这就是<strong>核聚变</strong>，
        与重核分裂的「裂变」正好相反。<strong>太阳和恒星</strong>的核心，
        就在极高的温度与压力下持续聚变，是宇宙中绝大多数光和热的来源。
      </p>

      <h3>核聚变的意义</h3>
      <p>
        聚变难在「点火」，可一旦驾驭，回报极具吸引力：反应<strong>本质安全</strong> ——
        条件稍有不足反应就立刻停下，不会像裂变那样失控熔毁；它也
        <strong>几乎不留长寿命的高放射性废料</strong>。如果能稳定地驾驭它，
        就意味着<strong>把恒星的能量带到地球</strong>，成为人类近乎终极的清洁能源。
      </p>

      <h3>聚变方程</h3>
      <p>
        <code>D + T → ⁴He + n + 17.6 MeV</code>
      </p>
      <p>
        氘和氚聚变生成一个<strong>氦-4 核</strong>（α 粒子，2 质子 + 2 中子）和一个
        <strong>高速中子</strong>，同时放出约 <strong>17.6 MeV</strong> 的能量 ——
        这正是太阳发光、以及人类追求的聚变能的核心反应。
      </p>

      <h3>能量从哪来（质量亏损）</h3>
      <p>
        生成物的总质量比反应物<strong>略小</strong>，少掉的那一点质量 Δm 按
        <code>E = Δm·c²</code> 变成了能量。因为 <code>c²</code> 极大，
        极小的质量差就对应巨大的能量 —— 这就是聚变释放能量的根本原因。
      </p>

      <h3>库仑势垒（为什么要「用力靠近」）</h3>
      <p>
        两个核都带<strong>正电</strong>，靠近时静电斥力急剧增大，像一道
        <strong>势垒</strong>挡在前面。只有把它们推得足够近，
        短程的<strong>强核力</strong>才会接管并把它们「粘」在一起。
        画面顶部的蓄能条就代表你正在克服这道库仑势垒 —— 它对应现实中聚变需要的
        极高温度与压力。
      </p>
    </>
  );
}

export function FusionInteraction() {
  return (
    <>
      <h3>动手让两个原子核聚变</h3>
      <p>
        这件展项邀请你<strong>用双手亲手促成一次核聚变</strong>。你的
        <strong>左手是氘核</strong>（²H，1 质子 + 1 中子），
        <strong>右手是氚核</strong>（³H，1 质子 + 2 中子）。张开双手，
        两团核云就会跟着你在画面里移动——接下来，把它们推到一起。
      </p>

      <h3>怎么互动</h3>
      <ul>
        <li>
          <strong>移动手掌</strong> → 核云在画面中的位置
        </li>
        <li>
          <strong>拇指↔食指捏合</strong> → 核云大小（捏紧变小、张开变大）
        </li>
        <li>
          <strong>把两团核云缓缓推到一起、顶住排斥力别松手</strong> → 顶部
          「库仑势垒」蓄能条填满 → 聚变闪光、金色氦核生成、中子高速弹出
        </li>
      </ul>
      <p>
        关键就是那一下<strong>「稳住，别松手」</strong>——你能亲手感到两个核
        互相排斥、却又被你一点点逼近的张力。
      </p>

      <h3>从你的双手到真正的太阳</h3>
      <p>
        现实中要让聚变持续发生，等离子体得烧到<strong>上亿度</strong>，
        没有任何容器盛得住——科学家于是用<strong>强磁场</strong>把它约束成一个
        <strong>甜甜圈形的磁笼</strong>、悬空旋转，这就是<strong>托卡马克</strong>；
        你刚才「顶住别松手」的那股劲，正是现实里用磁场维持高温高压的难题。
        中国是这条路上的重要力量：合肥的全超导托卡马克
        <strong>EAST（东方超环，「人造太阳」）</strong>不断刷新等离子体运行时长纪录，
        成都的<strong>中国环流三号（HL-3）</strong>也在推进燃烧等离子体实验，
        人类正一步步<strong>把恒星的能量带回地球</strong>。你已经亲手点燃了一次聚变——
        <strong>下一个展项，我们将走进托卡马克内部。</strong>
      </p>
    </>
  );
}
