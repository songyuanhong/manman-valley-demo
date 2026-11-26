// 试玩版限制（tools/build_demo.py 生成）：只开放教学和前两关，其余关卡提示「完整版开放」。
(function () {
  var ALLOW = {"index": 1, "title": 1, "valley": 1, "learn": 1, "level1": 1, "lake": 1}, LOCK = {"cloud": 1, "forest": 1, "song": 1, "leaf": 1, "epilogue": 1, "moon": 1, "snow": 1};
  var page = (location.pathname.split('/').pop() || 'index').replace('.html', '') || 'index';
  var V = window.VALLEY;
  if (V) { var go = V.go; V.go = function (p) { if (!ALLOW[p]) p = 'valley'; return go.call(this, p); }; }
  addEventListener('DOMContentLoaded', function () {
    if (page === 'valley' && typeof window.choose === 'function') {
      var choose0 = window.choose;
      window.choose = function () {
        try { var it = ITEMS[S.sel]; if (it && LOCK[it.id]) { if (typeof DAY !== 'undefined' && DAY.cancelNext) DAY.cancelNext(); flash('「' + it.name + '」在完整版开放。试玩版可以玩：送面包的早晨、倒流湖', 4); return; } } catch (e) {}
        return choose0.apply(this, arguments);
      };
    }
    if (page === 'index' && window.top === window) {
      var seen = false; try { seen = sessionStorage.mm_demo_intro === '1'; } catch (e) {}
      if (seen) return;
      var d = document.createElement('div');
      d.id = 'demointro';
      d.innerHTML = '<div class="box"><h1>慢慢谷物语 · 试玩版</h1>'
        + '<p>包含：动作教学、第一站「送面包的早晨」、第二站「倒流湖」。其余地点在完整版开放。</p>'
        + '<p><b>用身体玩</b>：电脑或电视接上摄像头，点左下角「📷 体感」→「开启摄像头」，站到屏幕前 2–3 米，全身入镜。画面只在这台电脑上处理，不录制、不上传。</p>'
        + '<p><b>用键盘玩</b>：方向键、空格、回车；按住 ↑ 等于双臂举高（开始 / 继续）。</p>'
        + '<p class="s">建议使用电脑版 Chrome 或 Edge，打开声音。</p>'
        + '<button>开始</button></div>';
      var st = document.createElement('style');
      st.textContent = '#demointro{position:fixed;inset:0;z-index:50;background:rgba(247,239,223,.97);display:flex;align-items:center;justify-content:center;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#5a4535}'
        + '#demointro .box{max-width:640px;padding:36px 44px;background:#fffaf0;border:3px solid #e2cfae;border-radius:28px;box-shadow:0 8px 0 rgba(70,48,28,.12)}'
        + '#demointro h1{margin:0 0 16px;font-size:30px}#demointro p{font-size:17px;line-height:1.7;margin:0 0 12px}#demointro .s{font-size:14px;color:#9b7f62}'
        + '#demointro button{margin-top:8px;font:800 20px "PingFang SC","Microsoft YaHei",sans-serif;padding:10px 40px;border-radius:16px;border:0;background:#9db577;color:#fff;cursor:pointer}';
      document.head.appendChild(st); document.body.appendChild(d);
      var close = function () { d.remove(); try { sessionStorage.mm_demo_intro = '1'; } catch (e) {} try { document.getElementById('game').contentWindow.focus(); } catch (e) {} };
      d.querySelector('button').onclick = close;
      addEventListener('keydown', function k(e) { if (document.getElementById('demointro') && (e.key === 'Enter' || e.key === ' ')) { e.stopImmediatePropagation(); e.preventDefault(); close(); removeEventListener('keydown', k, true); } }, true);
    }
  });
})();
