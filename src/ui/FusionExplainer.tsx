// Right-pane teaching copy for the deuterium–tritium fusion scene. Replaces
// the old CV-principle explainer. zh-CN per project convention.
export function FusionExplainer() {
  return (
    <>
      <h3>这是什么</h3>
      <p>
        两只手分别是两个<strong>原子核</strong>：左手是<strong>氘核</strong>
        （²H，1 个质子 + 1 个中子），右手是<strong>氚核</strong>
        （³H，1 个质子 + 2 个中子）。把两团核云慢慢靠到一起、顶住排斥力别松手，
        蓄满后就会<strong>聚变</strong>。
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

      <h3>手势怎么映射</h3>
      <ul>
        <li>
          <strong>手的位置</strong> → 原子核在画面中的位置
        </li>
        <li>
          <strong>拇指↔食指捏合距离</strong> → 核云的大小（捏紧变小、张开变大）
        </li>
        <li>
          <strong>两核重叠并保持</strong> → 蓄能 → 聚变闪光 → 氦核生成 + 中子弹出
        </li>
      </ul>

      <h3>玩法</h3>
      <p>
        张开双手，看两团核云分别跟着左右手移动；慢慢把它们靠拢、稳住，
        让顶部「库仑势垒」蓄能条填满，就能看到聚变闪光、金色氦核与高速弹出的中子。
      </p>
    </>
  );
}
