/* 塞壬的小把戏 —— 熟曲库（公有领域）
 *
 * 依据：02-后端开发规格书 D8
 *   · 仅收公有领域：民歌、童谣、古典；逐条注 source
 *   · 不收：《生日快乐》、20 世纪后流行曲、影视配乐
 *   · 做成 .js 赋值给 window.Siren.MELODIES（fetch 被禁，必须 <script src> 引入，D2）
 *   · 按音数分桶索引，便于按乐句音数抽取
 *
 * ⚠️ 与规格书 D8 的一处必要偏离（已上报）：
 *   D8 给的示例 degrees 是五声音阶（0/2/4/7/9，C D E G A）。但中文最耳熟能详的公版童谣
 *   基本都不是五声音阶——《小星星》含 F(3) 和 B(6)，《两只老虎》含 F(3)。
 *   若硬套五声音阶折算，旋律会被改写到"听不出来"，直接毁掉 D8 想要的"耳熟能详"。
 *   因此本库用 'major' 自然大调级数，而**原创旋律仍严格用五声音阶**（见 melody.js）。
 *   这样既保住"一耳听清"，也不影响 P2（相对音高、移调补偿）——两者都与音阶无关。
 *
 * degrees：级数，0 = 主音 C4（MIDI 60）。可用负数 / ≥7 跨八度。
 *           major 音阶：0..6 = C D E F G A B，7 = 高八度 C
 * eighths：以八分音符为单位的时值（BPM 92 → 八分 = 326.09ms）。D4.6 要求全部为整数格。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  Siren.MELODIES = [
    {
      title: '小星星',
      scale: 'major',
      publicDomain: true,
      source: '法国童谣 Ah! vous dirai-je, maman (1761)',
      phrases: [
        { degrees: [0, 0, 4, 4, 5, 5, 4],          eighths: [2, 2, 2, 2, 2, 2, 4] },
        { degrees: [3, 3, 2, 2, 1, 1, 0],          eighths: [2, 2, 2, 2, 2, 2, 4] },
        { degrees: [4, 4, 3, 3, 2, 2, 1],          eighths: [2, 2, 2, 2, 2, 2, 4] },
        { degrees: [4, 4, 3, 3, 2, 2, 1],          eighths: [2, 2, 2, 2, 2, 2, 4] },
        { degrees: [0, 0, 4, 4, 5, 5, 4],          eighths: [2, 2, 2, 2, 2, 2, 4] },
        { degrees: [3, 3, 2, 2, 1, 1, 0],          eighths: [2, 2, 2, 2, 2, 2, 4] }
      ]
    },
    {
      title: '两只老虎',
      scale: 'major',
      publicDomain: true,
      source: '法国童谣 Frère Jacques (约 1780)',
      phrases: [
        { degrees: [0, 1, 2, 0],                    eighths: [2, 2, 2, 2] },
        { degrees: [0, 1, 2, 0],                    eighths: [2, 2, 2, 2] },
        { degrees: [2, 3, 4, 4],                    eighths: [2, 2, 2, 2] },
        { degrees: [2, 3, 4, 4],                    eighths: [2, 2, 2, 2] },
        { degrees: [4, 5, 4, 3, 2, 0],              eighths: [1, 1, 2, 1, 1, 2] },
        { degrees: [4, 5, 4, 3, 2, 0],              eighths: [1, 1, 2, 1, 1, 2] },
        { degrees: [0, -4, 0],                      eighths: [2, 2, 4] },
        { degrees: [0, -4, 0],                      eighths: [2, 2, 4] }
      ]
    },
    {
      title: '欢乐颂',
      scale: 'major',
      publicDomain: true,
      source: '贝多芬第九交响曲第四乐章主题 (1824)',
      phrases: [
        { degrees: [2, 2, 3, 4],                    eighths: [2, 2, 2, 2] },
        { degrees: [4, 3, 2, 1],                    eighths: [2, 2, 2, 2] },
        { degrees: [0, 0, 1, 2],                    eighths: [2, 2, 2, 2] },
        { degrees: [2, 1, 1],                       eighths: [2, 1, 3] },
        { degrees: [2, 2, 3, 4],                    eighths: [2, 2, 2, 2] },
        { degrees: [4, 3, 2, 1],                    eighths: [2, 2, 2, 2] },
        { degrees: [0, 0, 1, 2],                    eighths: [2, 2, 2, 2] },
        { degrees: [1, 0, 0],                       eighths: [2, 1, 3] }
      ]
    }
  ];

  /**
   * 按音数分桶索引，便于按乐句音数抽取（D8 要求）。
   * 结构：{ 3: [ {title, phrase, [...]} ], 4: [...], ... }
   */
  Siren.MELODY_INDEX = (function () {
    var index = {};
    var list = Siren.MELODIES;
    for (var i = 0; i < list.length; i += 1) {
      var song = list[i];
      for (var j = 0; j < song.phrases.length; j += 1) {
        var ph = song.phrases[j];
        var n = ph.degrees.length;
        if (!index[n]) index[n] = [];
        index[n].push({
          title: song.title,
          scale: song.scale,
          publicDomain: !!song.publicDomain,
          source: song.source,
          degrees: ph.degrees,
          eighths: ph.eighths,
          phraseNo: j
        });
      }
    }
    return index;
  })();
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
