// ============================================================
// 瑞士制排陣核心邏輯（由 Excel VBA「瑞士制 排陣系統 8.28 正式版」Module1 逐行移植）
//
// 資料模型刻意模仿 Excel 賽程表，讓每一行都能跟 VBA 對照：
//   sheet.rows[k]  對應賽程表第 k+5 列（k 從 0 開始）
//     .id    = A欄 籤號（字串）
//     .name  = B欄 姓名
//     .res[r] = 第 r+1 輪「成績」欄（○ / × / 空字串）
//     .opp[r] = 第 r+1 輪「對手」欄（對手籤號 / 空 / 棄 / 空字串）
//   參賽人數 numPlayers 之後的那一列（rows[numPlayers]）就是「假人(輪空)」那一列，
//   跟 Excel 一樣會被寫入輪空對象的籤號與 ×。
//
// ⚠ 排陣規則請勿自行「優化」：這份程式的正確性是靠跟 Excel 版對拍驗證來保證的，
//   改任何一行都要重新跑 驗證/ 底下的對拍測試。
// ============================================================
(function (root) {
  'use strict';

  var AUTHOR = String.fromCharCode(19000 + 7366, 19000 + 2697, 19000 + 1625);

  // VBA 的 Trim 只去掉半形空白
  function vbTrim(s) { return String(s).replace(/^ +| +$/g, ''); }
  function str(v) { return v === undefined || v === null ? '' : String(v); }

  // 反向掃描偵測人數（嚴格過濾空白、0、-）
  function countPlayers(sheet) {
    for (var k = sheet.rows.length - 1; k >= 0; k--) {
      var s = vbTrim(str(sheet.rows[k].name));
      if (s !== '' && s !== '0' && s !== '-') return k + 1;
    }
    return 0;
  }

  // 確保 rows 至少有 n 列（含假人列），缺的補空白列
  function ensureRows(sheet, n) {
    while (sheet.rows.length < n) {
      sheet.rows.push({ id: String(sheet.rows.length + 1), name: '', res: [], opp: [] });
    }
  }
  function getRes(row, r) { return str(row.res[r]); }
  function getOpp(row, r) { return str(row.opp[r]); }

  // ============================================================
  // 產生第一輪賽程
  // ============================================================
  function pairFirstRound(sheet) {
    var numPlayers = countPlayers(sheet);
    if (numPlayers < 2) return { ok: false, message: '人數不足無法排陣，請確認名單！' };

    ensureRows(sheet, numPlayers + 1);
    // ws.Range("D5:D200").ClearContents —— 只清對手欄，不清成績欄（照原版）
    sheet.rows.forEach(function (row) { row.opp[0] = ''; });

    var dummyRow = 0;
    if (numPlayers % 2 === 1) dummyRow = numPlayers; // 0-based

    for (var i = 0; i < numPlayers; i += 2) {
      if (i === numPlayers - 1) {
        sheet.rows[i].opp[0] = '空';
        sheet.rows[i].res[0] = '○';
        sheet.rows[dummyRow].opp[0] = str(sheet.rows[i].id);
        sheet.rows[dummyRow].res[0] = '×';
      } else {
        sheet.rows[i].opp[0] = str(sheet.rows[i + 1].id);
        sheet.rows[i + 1].opp[0] = str(sheet.rows[i].id);
      }
    }
    return {
      ok: true, numPlayers: numPlayers,
      message: '第一輪對戰組合已自動排定完成！\n實際套用參賽人數：' + numPlayers + '人'
    };
  }

  // ============================================================
  // 自動排定後續賽程（r = 要排的輪次，從 2 開始）
  // ============================================================
  function pairNextRound(sheet, r) {
    r = Number(r);
    var maxRounds = sheet.maxRounds || 7;
    if (!(r >= 2 && r <= maxRounds) || Math.floor(r) !== r) {
      return { ok: false, message: '此系統目前支援第 2 到第 ' + maxRounds + ' 輪的排陣！' };
    }

    var numPlayers = countPlayers(sheet);
    ensureRows(sheet, numPlayers + 1);
    var rows = sheet.rows;

    var activeCount = 0;
    var isWithdrawn = new Array(numPlayers + 1);
    var i, j, rIdx;
    for (i = 1; i <= numPlayers; i++) {
      var pname = vbTrim(str(rows[i - 1].name));
      if (pname.indexOf('棄') >= 0 || pname.indexOf('退') >= 0) {
        isWithdrawn[i] = true;
      } else {
        isWithdrawn[i] = false;
        activeCount++;
      }
    }
    if (activeCount < 2) return { ok: false, message: '扣除棄賽者後，有效參賽人數不足無法排陣！' };

    var totalN = activeCount;
    var hasDummy = false;
    if (totalN % 2 === 1) { totalN++; hasDummy = true; }

    // 以下陣列都用 1-based，跟 VBA 一致
    var actOrigRow = new Array(totalN + 1);
    var currA = 1;
    for (i = 1; i <= numPlayers; i++) {
      if (!isWithdrawn[i]) { actOrigRow[currA] = i; currA++; }
    }

    var dummyID = '';
    if (hasDummy) {
      actOrigRow[totalN] = numPlayers + 1;
      dummyID = str(rows[numPlayers].id);
      if (dummyID === '') dummyID = '空';
    }

    var playerID = new Array(totalN + 1);
    var playerScore = new Array(totalN + 1);
    var mainScore = new Array(totalN + 1);
    var hasPlayed = [];
    for (i = 0; i <= totalN; i++) hasPlayed.push(new Array(totalN + 1).fill(false));
    var scoreBefore = [];
    var floatUp = new Array(totalN + 1).fill(0);
    var floatDown = new Array(totalN + 1).fill(0);
    var hasHadBye = new Array(totalN + 1).fill(false);

    for (i = 1; i <= totalN; i++) {
      var origI = actOrigRow[i];
      scoreBefore[i] = new Array(r + 1);
      if (hasDummy && i === totalN) {
        playerID[i] = dummyID;
        mainScore[i] = -999;
        playerScore[i] = -999;
        for (rIdx = 1; rIdx <= r; rIdx++) scoreBefore[i][rIdx] = -999;
      } else {
        playerID[i] = str(rows[origI - 1].id);
        var s = 0;
        scoreBefore[i][1] = 0;
        for (rIdx = 1; rIdx <= r - 1; rIdx++) {
          var resVal = getRes(rows[origI - 1], rIdx - 1);
          if (resVal.indexOf('○') >= 0 || resVal.toUpperCase().indexOf('O') >= 0 || resVal.indexOf('1') >= 0) s++;
          scoreBefore[i][rIdx + 1] = s;
        }
        mainScore[i] = s;
        // 第二優先：分數最高、號碼最小開始排
        playerScore[i] = s - (origI * 0.0001);
      }
    }

    for (i = 1; i <= totalN; i++) {
      if (hasDummy && i === totalN) continue;
      var oi = actOrigRow[i];
      for (rIdx = 1; rIdx <= r - 1; rIdx++) {
        var oppID = getOpp(rows[oi - 1], rIdx - 1);
        if (oppID === '空' || oppID === '輪空' || oppID === dummyID) {
          hasHadBye[i] = true;
          if (hasDummy) { hasPlayed[i][totalN] = true; hasPlayed[totalN][i] = true; }
        } else if (oppID !== '' && oppID !== '棄賽' && oppID.indexOf('棄') < 0) {
          var oppIndex = 0;
          for (j = 1; j <= totalN; j++) {
            if (playerID[j] === oppID) { oppIndex = j; break; }
          }
          if (oppIndex > 0) {
            hasPlayed[i][oppIndex] = true;
            hasPlayed[oppIndex][i] = true;
            if (scoreBefore[i][rIdx] > scoreBefore[oppIndex][rIdx]) floatDown[i]++;
            else if (scoreBefore[i][rIdx] < scoreBefore[oppIndex][rIdx]) floatUp[i]++;
          }
        }
      }
    }

    var sortIdx = new Array(totalN + 1);
    for (i = 1; i <= totalN; i++) sortIdx[i] = i;
    for (i = 1; i <= totalN - 1; i++) {
      for (j = i + 1; j <= totalN; j++) {
        if (playerScore[sortIdx[i]] < playerScore[sortIdx[j]]) {
          var t = sortIdx[i]; sortIdx[i] = sortIdx[j]; sortIdx[j] = t;
        }
      }
    }
    var sortIdxOriginal = sortIdx.slice();

    var paired, historyI, historyJ, pairCount;

    // 挑選「輪高」接招人選（號碼最小；由嚴到寬逐關卡嘗試）
    function selectReceiverPos(startPos, endPos, toleranceLevel, floaterIdx) {
      for (var tier = 0; tier <= toleranceLevel; tier++) {
        var bestPos = 0, bestIdx = -1;
        for (var k = startPos; k <= endPos; k++) {
          if (!paired[k]) {
            var idx = sortIdx[k];
            if (!hasPlayed[floaterIdx][idx]) {
              var eligible = tier >= 1 ? true : (floatUp[idx] === 0);
              if (eligible && (bestPos === 0 || idx < bestIdx)) { bestIdx = idx; bestPos = k; }
            }
          }
        }
        if (bestPos !== 0) return bestPos;
      }
      return 0;
    }

    // 分數組內配對＋自然浮現的輪低者（回溯法）
    // floaterRef.v 對應 VBA 的 ByRef floaterPos
    function matchRangeWithFloat(startPos, endPos, tier, needFloat, nextStart, nextEnd, floaterRef) {
      var currI = 0, k;
      for (k = startPos; k <= endPos; k++) {
        if (!paired[k]) { currI = k; break; }
      }
      if (currI === 0) return true;

      for (var jj = startPos; jj <= endPos; jj++) {
        if (jj !== currI && !paired[jj]) {
          if (!hasPlayed[sortIdx[currI]][sortIdx[jj]]) {
            paired[currI] = true; paired[jj] = true;
            pairCount++;
            historyI[pairCount] = currI;
            historyJ[pairCount] = jj;
            if (matchRangeWithFloat(startPos, endPos, tier, needFloat, nextStart, nextEnd, floaterRef)) return true;
            paired[currI] = false; paired[jj] = false;
            pairCount--;
          }
        }
      }

      if (needFloat && floaterRef.v === 0) {
        var idx = sortIdx[currI];
        var eligible;
        if (tier >= 3) eligible = true;
        else if (tier >= 2) eligible = !hasHadBye[idx];
        else eligible = !hasHadBye[idx] && floatDown[idx] === 0;
        if (eligible && nextEnd !== 0) {
          var hasValidReceiver = false;
          for (k = nextStart; k <= nextEnd; k++) {
            if (!paired[k] && !hasPlayed[idx][sortIdx[k]]) { hasValidReceiver = true; break; }
          }
          if (hasValidReceiver) {
            paired[currI] = true;
            floaterRef.v = currI;
            if (matchRangeWithFloat(startPos, endPos, tier, needFloat, nextStart, nextEnd, floaterRef)) return true;
            paired[currI] = false;
            floaterRef.v = 0;
          }
        }
      }
      return false;
    }

    // 依分數組「由高到低、層層配對」，必要時漸進放寬容忍等級
    var toleranceLevel = 0, maxTolerance = 3, overallSuccess = false;
    while (toleranceLevel <= maxTolerance) {
      sortIdx = sortIdxOriginal.slice();
      paired = new Array(totalN + 1).fill(false);
      historyI = new Array(totalN / 2 + 1).fill(0);
      historyJ = new Array(totalN / 2 + 1).fill(0);
      pairCount = 0;

      var carryFromPos = 0;
      var pos = 1;
      var cascadeOK = true;
      while (pos <= totalN) {
        while (pos <= totalN && paired[pos]) pos++;
        if (pos > totalN) break;

        var limitPos = pos;
        var bracketScore = mainScore[sortIdx[pos]];
        while (limitPos + 1 <= totalN && mainScore[sortIdx[limitPos + 1]] === bracketScore) limitPos++;

        var stepOK = true;
        var newFloaterPos = 0;

        // 第一步：先處理上一組送下來的輪低者
        if (carryFromPos !== 0) {
          var receiverPos = selectReceiverPos(pos, limitPos, toleranceLevel, sortIdx[carryFromPos]);
          if (receiverPos === 0) {
            stepOK = false;
          } else {
            pairCount++;
            historyI[pairCount] = carryFromPos;
            historyJ[pairCount] = receiverPos;
            paired[carryFromPos] = true;
            paired[receiverPos] = true;
          }
          carryFromPos = 0;
        }

        // 第二步：剩下原生成員整批配對，單數時讓落單者自然成為輪低者
        if (stepOK) {
          var remainNative = 0, kk;
          for (kk = pos; kk <= limitPos; kk++) if (!paired[kk]) remainNative++;
          if (remainNative > 0) {
            var needFloat = remainNative % 2 === 1;
            if (needFloat) {
              var nextStart = limitPos + 1, nextEnd;
              if (nextStart <= totalN) {
                var nextScore = mainScore[sortIdx[nextStart]];
                nextEnd = nextStart;
                while (nextEnd + 1 <= totalN && mainScore[sortIdx[nextEnd + 1]] === nextScore) nextEnd++;
              } else {
                nextEnd = 0;
              }
              var foundOK = false;
              for (var tier = 0; tier <= toleranceLevel; tier++) {
                var fRef = { v: 0 };
                if (matchRangeWithFloat(pos, limitPos, tier, true, nextStart, nextEnd, fRef)) {
                  newFloaterPos = fRef.v;
                  foundOK = true;
                  break;
                }
              }
              stepOK = foundOK;
            } else {
              stepOK = matchRangeWithFloat(pos, limitPos, toleranceLevel, false, 0, 0, { v: 0 });
            }
          }
        }

        if (!stepOK) { cascadeOK = false; break; }
        if (newFloaterPos !== 0) carryFromPos = newFloaterPos;
        pos = limitPos + 1;
      }

      if (cascadeOK && carryFromPos !== 0) cascadeOK = false;
      if (cascadeOK) { overallSuccess = true; break; }
      toleranceLevel++;
    }

    if (!overallSuccess) return { ok: false, message: '系統演算後發現死胡同，請確認成績是否填寫正確！' };

    // 輸出
    var col = r - 1;
    for (i = 0; i <= numPlayers; i++) { rows[i].opp[col] = ''; rows[i].res[col] = ''; }

    for (i = 1; i <= totalN / 2; i++) {
      var p1 = sortIdx[historyI[i]];
      var p2 = sortIdx[historyJ[i]];
      var row1 = actOrigRow[p1];
      var row2 = actOrigRow[p2];
      if (hasDummy && p1 === totalN) {
        rows[row2 - 1].opp[col] = '空';
        rows[row2 - 1].res[col] = '○';
        rows[numPlayers].opp[col] = playerID[p2];
        rows[numPlayers].res[col] = '×';
      } else if (hasDummy && p2 === totalN) {
        rows[row1 - 1].opp[col] = '空';
        rows[row1 - 1].res[col] = '○';
        rows[numPlayers].opp[col] = playerID[p1];
        rows[numPlayers].res[col] = '×';
      } else {
        rows[row1 - 1].opp[col] = playerID[p2];
        rows[row2 - 1].opp[col] = playerID[p1];
      }
    }

    for (i = 1; i <= numPlayers; i++) {
      if (!isWithdrawn[i]) continue;
      var alreadyMarked = false;
      for (var cR = 1; cR <= r - 1; cR++) {
        if (getOpp(rows[i - 1], cR - 1).indexOf('棄') >= 0) { alreadyMarked = true; break; }
      }
      if (!alreadyMarked) { rows[i - 1].opp[col] = '棄'; rows[i - 1].res[col] = '×'; }
      else { rows[i - 1].opp[col] = ''; rows[i - 1].res[col] = ''; }
    }

    var msg = '第 ' + r + ' 輪對戰組合排定完成！\n';
    if (toleranceLevel > 0) msg += '【提醒】啟動了漸進式必要放寬機制（容忍等級：' + toleranceLevel + '）。\n';
    msg += '當前有效參賽人數：' + activeCount + '人\n（已扣除 ' + (numPlayers - activeCount) + ' 名棄賽者）';
    return { ok: true, tolerance: toleranceLevel, activeCount: activeCount, withdrawn: numPlayers - activeCount, message: msg };
  }

  // ============================================================
  // 產生最終排名（台灣標準：主分 → 第一輔分SOS → 第二輔分(所負對手主分)
  //   → 直接對戰 → 第四輔分SOSOS）
  // 回傳 { ok, rows:[{rank, id, name, main, sos, sodosL, headWin, sosos, withdrawn}] }
  // ============================================================
  function computeRanking(sheet) {
    var numPlayers = countPlayers(sheet);
    if (numPlayers < 2) return { ok: false, message: '沒有足夠的選手資料可供結算！' };
    ensureRows(sheet, numPlayers + 1);
    var rows = sheet.rows;
    var maxRounds = sheet.maxRounds || 7;

    var maxR = 1, rd, i, j;
    for (rd = maxRounds; rd >= 1; rd--) {
      var hasResult = false;
      for (i = 0; i < numPlayers; i++) {
        if (vbTrim(getRes(rows[i], rd - 1)) !== '') { hasResult = true; break; }
      }
      if (hasResult) { maxR = rd; break; }
    }

    var pName = [], pID = [], withdrawn = [], sMain = [], sSOS = [], sSODOS = [], sSOSOS = [], sHead = [];
    var oppRec = [], winRec = [];
    for (i = 1; i <= numPlayers; i++) {
      pID[i] = vbTrim(str(rows[i - 1].id));
      pName[i] = vbTrim(str(rows[i - 1].name));
      withdrawn[i] = pName[i].indexOf('棄') >= 0 || pName[i].indexOf('退') >= 0;
      oppRec[i] = []; winRec[i] = [];
      var m = 0;
      for (rd = 1; rd <= maxR; rd++) {
        var res = getRes(rows[i - 1], rd - 1);
        var opp = getOpp(rows[i - 1], rd - 1);
        if (res.indexOf('○') >= 0 || res.indexOf('1') >= 0) { m++; winRec[i][rd] = true; }
        else winRec[i][rd] = false;
        oppRec[i][rd] = 0;
        if (opp !== '' && opp !== '空' && opp.indexOf('棄') < 0) {
          for (j = 1; j <= numPlayers; j++) {
            if (vbTrim(str(rows[j - 1].id)) === opp) { oppRec[i][rd] = j; break; }
          }
        }
      }
      sMain[i] = m;
    }

    for (i = 1; i <= numPlayers; i++) {
      var sos = 0, sodos = 0;
      for (rd = 1; rd <= maxR; rd++) {
        var o = oppRec[i][rd];
        if (o > 0) {
          sos += sMain[o];
          if (!winRec[i][rd]) sodos += sMain[o];
        }
      }
      sSOS[i] = sos; sSODOS[i] = sodos;
    }
    for (i = 1; i <= numPlayers; i++) {
      var sosos = 0;
      for (rd = 1; rd <= maxR; rd++) if (oppRec[i][rd] > 0) sosos += sSOS[oppRec[i][rd]];
      sSOSOS[i] = sosos;
    }
    // 第三輔分：是否曾經直接打贏過主分/第一輔分/第二輔分皆相同的對手
    for (i = 1; i <= numPlayers; i++) {
      var hw = 0;
      for (rd = 1; rd <= maxR; rd++) {
        var oi = oppRec[i][rd];
        if (oi > 0 && sMain[i] === sMain[oi] && sSOS[i] === sSOS[oi] && sSODOS[i] === sSODOS[oi] && winRec[i][rd]) hw = 1;
      }
      sHead[i] = hw;
    }

    // 排序（照原版的交換排序，不可改成 Array.sort：直接對戰的比較不具遞移性）
    var sortArr = [];
    for (i = 1; i <= numPlayers; i++) sortArr[i] = i;
    for (i = 1; i <= numPlayers - 1; i++) {
      for (j = i + 1; j <= numPlayers; j++) {
        var p1 = sortArr[i], p2 = sortArr[j], swap = false;
        if (withdrawn[p1] && !withdrawn[p2]) swap = true;
        else if (!withdrawn[p1] && withdrawn[p2]) swap = false;
        else if (sMain[p1] < sMain[p2]) swap = true;
        else if (sMain[p1] === sMain[p2]) {
          if (sSOS[p1] < sSOS[p2]) swap = true;
          else if (sSOS[p1] === sSOS[p2]) {
            if (sSODOS[p1] < sSODOS[p2]) swap = true;
            else if (sSODOS[p1] === sSODOS[p2]) {
              var directWin = 0;
              for (var cR = 1; cR <= maxR; cR++) {
                if (oppRec[p1][cR] === p2) directWin = winRec[p1][cR] ? 1 : 2;
              }
              if (directWin === 2) swap = true;
              else if (directWin === 0 && sSOSOS[p1] < sSOSOS[p2]) swap = true;
            }
          }
        }
        if (swap) { var t = sortArr[i]; sortArr[i] = sortArr[j]; sortArr[j] = t; }
      }
    }

    var out = [];
    var rankNum = 1;
    for (i = 1; i <= numPlayers; i++) {
      var p = sortArr[i];
      if (withdrawn[p]) {
        out.push({ rank: '-', id: '', name: pName[p], withdrawn: true });
        continue;
      }
      if (i > 1) {
        var pr = sortArr[i - 1];
        if (sMain[p] === sMain[pr] && sSOS[p] === sSOS[pr] && sSODOS[p] === sSODOS[pr] && sSOSOS[p] === sSOSOS[pr]) {
          var isLoss = false;
          for (rd = 1; rd <= maxR; rd++) if (oppRec[p][rd] === pr && !winRec[p][rd]) isLoss = true;
          if (isLoss) rankNum = i;
        } else {
          rankNum = i;
        }
      }
      out.push({
        rank: rankNum, id: pID[p], name: pName[p], main: sMain[p], sos: sSOS[p],
        sodosL: sSODOS[p], headWin: sHead[p], sosos: sSOSOS[p], withdrawn: false
      });
    }
    return { ok: true, maxR: maxR, rows: out };
  }

  var api = {
    AUTHOR: AUTHOR,
    countPlayers: countPlayers,
    pairFirstRound: pairFirstRound,
    pairNextRound: pairNextRound,
    computeRanking: computeRanking
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwissCore = api;
})(this);
