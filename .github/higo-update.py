"""成績系統 ↔ HiGO 圍棋 棋譜連結配對（2026-11-10 建立）

做什麼：
  1. 讀 HiGO 公開棋譜清單（api.higohigo.org，跟 HiGO 網頁版讀的是同一份公開資料，不用登入，不抓棋譜內容）
  2. 讀新成績系統雲端全部對局（Firestore 公開讀 results/y年份）
  3. 用「日期＋黑方＋白方」配對，產生 higo.json，寫到
       成績系統\\higo.json（本機測試用）
       qisai-schedule-web\\results\\higo.json（按「更新賽程表網站.bat」才會發布）
  成績系統網頁讀 higo.json，在明細表多一欄「棋譜」連到 https://www.higohigo.org/#/kifu/<編號>

配對規則（每份 HiGO 棋譜最多配一局，分數高的先配）：
  ・同一天、黑白一樣：一定接受
  ・同一天、黑白相反，或差一天、黑白一樣：只有「勝的人」對得上（或讀不出勝方）才接受
  ・同一天同一對有好幾份棋譜時，看勝的人、賽名、階段誰比較像
  ・上面都配完後，剩下的才用「日期差 2～10 天」：黑白一樣、勝的人一樣、賽名像，日期越近越優先
    （HiGO 的日期常是上傳/轉播日，2026-11-10 加）
  ・最後：同一年、同一個比賽、同兩人、勝的人一樣，而且那一年那個比賽兩邊都只有這一盤 → 日期不管也配
    （使用者規則：一個比賽一年內同兩人只會碰一次，決賽除外；2026-11-10 加）

用法：python higo-update.py        （本機：更新棋譜連結.bat 會幫忙跑）
自動：GitHub 每天跑一次（.github/workflows/higo-update.yml），有變化才更新 results/higo.json 並發布
      2026-11-26 起本檔放在 qisai-schedule-web/.github/，原本 工具/更新HiGO棋譜連結.py 不再使用
higo.json 格式：{"generated":..., "map":{"年份|日期|黑|白":[棋譜編號,...]}, ...}
  同一天同一對下兩盤時，同一個鍵會有兩個編號（依配對到的順序）。
"""
import json, os, re, sys, time, datetime, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))   # qisai-schedule-web\.github
REPO = os.path.dirname(HERE)                         # qisai-schedule-web
BASE = os.path.dirname(REPO)                         # 棋賽賽程操作台（GitHub 上沒有這層，會自動略過）
OUTS = [os.path.join(BASE, '成績系統', 'higo.json'),
        os.path.join(REPO, 'results', 'higo.json')]
TW = datetime.timezone(datetime.timedelta(hours=8))
API = 'https://api.higohigo.org/graphql'
FIRESTORE = 'https://firestore.googleapis.com/v1/projects/test-5cfc9/databases/(default)/documents/results?pageSize=300'
HDR = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (qisai-results)', 'Origin': 'https://www.higohigo.org'}

Q = ('query($f: PublicKifuFilter!){ publicKifus(filter:$f){ count kifus{ id gameStartedAt winningWay tournamentName '
     'blackPlayer{name} whitePlayer{name} series{name tournament{name}} } } }')


def http_json(url, body=None, headers=None):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, headers or {})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def fetch_higo():
    """抓全部公開棋譜清單。這個 API 遇到同時間的棋譜時分頁順序不固定，所以換幾種排序抓到湊齊為止。"""
    orders = [[{'column': 'gameStartedAt', 'reverse': False}, {'column': 'seq', 'reverse': False}],
              [{'column': 'gameStartedAt', 'reverse': True}, {'column': 'seq', 'reverse': True}],
              [{'column': 'seq', 'reverse': False}, {'column': 'gameStartedAt', 'reverse': False}]]
    got, total = {}, None
    for o in orders:
        page = 1
        while True:
            d = http_json(API, {'query': Q, 'variables': {'f': {'limit': 1000, 'page': page, 'orderBy': o}}}, HDR)
            if 'errors' in d:
                raise RuntimeError('HiGO 回傳錯誤：' + json.dumps(d['errors'], ensure_ascii=False)[:300])
            d = d['data']['publicKifus']; total = d['count']
            for k in d['kifus']:
                got[k['id']] = k
            print(f'\r  HiGO 棋譜清單：{len(got):,} / {total:,}', end='', flush=True)
            if len(d['kifus']) < 1000:
                break
            page += 1; time.sleep(0.3)
        if len(got) >= total:
            break
    print()
    if len(got) < total:
        print(f'  ⚠ HiGO 有 {total - len(got)} 份棋譜沒抓到（不影響其他配對）')
    return list(got.values()), total


def fetch_results():
    d = http_json(FIRESTORE)
    games = []
    for doc in d.get('documents', []):
        nm = doc['name'].split('/')[-1]
        if not re.fullmatch(r'y\d{4}', nm) or 'rows' not in doc['fields']:
            continue
        for r in json.loads(doc['fields']['rows']['stringValue']):
            r = [re.sub(r'\s+', '', str(x or '')) for x in r[:9]]
            games.append({'y': nm[1:], 'd': r[0], 'ev': r[3], 'st': r[4], 'b': r[5], 'w': r[6], 'win': r[7], 'mv': r[8]})
    return games


def tw_date(iso):
    t = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')) + datetime.timedelta(hours=8)
    return t.date()


def higo_winner(k):
    """HiGO 勝方：回傳 'B' / 'W' / None"""
    w = (k.get('winningWay') or '').strip().replace('黒', '黑')
    if w.startswith(('黑', 'B')): return 'B'
    if w.startswith(('白', 'W')): return 'W'
    return None


def norm_txt(s):
    return (s or '').replace('杯', '盃').replace('臺', '台').replace('戰', '賽')


def sim(a, b):
    """兩段文字共同字元的比例（0～1）"""
    a, b = set(norm_txt(a)), set(norm_txt(b))
    return len(a & b) / len(a) if a else 0


def main():
    print('1/3 讀 HiGO 公開棋譜清單…')
    kifus, higo_total = fetch_higo()
    print('2/3 讀新成績系統雲端對局…')
    games = fetch_results()
    print(f'  成績系統：{len(games):,} 局')

    print('3/3 配對中…')
    idx = defaultdict(list)
    for k in kifus:
        if k.get('gameStartedAt') and k.get('blackPlayer') and k.get('whitePlayer'):
            k['_d'] = tw_date(k['gameStartedAt'])
            k['_b'] = re.sub(r'\s+', '', k['blackPlayer']['name']); k['_w'] = re.sub(r'\s+', '', k['whitePlayer']['name'])
            idx[(k['_d'], k['_b'], k['_w'])].append(k)

    cands = []   # (分數, 對局序號, 棋譜id)
    for gi, g in enumerate(games):
        m = re.fullmatch(r'(\d{1,2})\.(\d{1,2})', g['d'])
        if not m:
            continue
        try:
            d0 = datetime.date(int(g['y']), int(m.group(1)), int(m.group(2)))
        except ValueError:
            continue
        # (日期, 黑, 白, 基本分, 第幾層)；第1層先全部配完，剩下的棋譜才給第2層
        tries = [(d0, g['b'], g['w'], 100, 1), (d0, g['w'], g['b'], 60, 1)]
        for dd in (-1, 1):
            tries.append((d0 + datetime.timedelta(days=dd), g['b'], g['w'], 50, 1))
        # 第2層（2026-11-10 放寬）：HiGO 的日期常是上傳/轉播日，跟比賽日差 2～10 天
        #   → 黑白一樣、勝的人一樣、賽名也像（共同字 ≥ 一半）才算，日期越近越優先
        for dd in range(2, 11):
            for sgn in (-1, 1):
                tries.append((d0 + datetime.timedelta(days=sgn * dd), g['b'], g['w'], 40 - dd, 2))
        for d, b, w, base, tier in tries:
            for k in idx.get((d, b, w), []):
                hw = higo_winner(k)
                win_person = None if hw is None else (k['_b'] if hw == 'B' else k['_w'])
                agree = None if (win_person is None or not g['win']) else (win_person == g['win'])
                if base < 100 and agree is False:
                    continue                      # 不是同一天同黑白，勝的人又對不上 → 不算
                tour = ((k.get('series') or {}).get('tournament') or {}).get('name') or k.get('tournamentName') or ''
                ev_sim = sim(g['ev'], tour)
                if tier == 2 and (agree is not True or ev_sim < 0.5):
                    continue                      # 差好幾天：勝的人要確定一樣、賽名也要像
                score = base + (30 if agree else (-30 if agree is False else 0)) \
                    + 20 * ev_sim + 10 * sim(g['st'], (k.get('series') or {}).get('name') or '')
                cands.append((tier, score, gi, k['id']))

    cands.sort(key=lambda x: (x[0], -x[1]))
    game_kifu, used, tier2 = {}, set(), 0
    for tier, score, gi, kid in cands:
        if gi in game_kifu or kid in used:
            continue
        game_kifu[gi] = kid; used.add(kid)
        if tier == 2: tier2 += 1

    # 第3層（2026-11-10 使用者規則：「一個比賽，一年內同兩人只會對到一次，決賽除外」）
    #   同一年＋同一個比賽＋同兩人（黑白不拘）＋勝的人一樣，日期不管。
    #   保險：那一年那個比賽，成績系統只有這一盤、HiGO 也只有這一份（還沒被配走），才配。
    #   → 決賽番棋、雙敗淘汰勝部敗部各碰一次、同一年有兩屆（棋王賽9月循環圈＋10月初賽）都會自動跳過。
    def tkey(ev):
        return norm_txt(ev).replace('中環', '')
    def same_tour(ev, tour):
        a, b = tkey(ev), tkey(tour)
        # 用「開頭相同」而不是「包含」：棋王賽 不能配到 LG盃世界棋王賽（2018 王元均/蕭正浩 踩過）
        return bool(a) and bool(b) and (b.startswith(a) or a.startswith(b))
    by_pair_year = defaultdict(list)
    for k in kifus:
        if '_d' in k:
            by_pair_year[(frozenset([k['_b'], k['_w']]), k['_d'].year)].append(k)
    g_pair_year = defaultdict(list)
    for gi, g in enumerate(games):
        g_pair_year[(frozenset([g['b'], g['w']]), g['y'])].append(gi)
    tier3 = 0
    for gi, g in enumerate(games):
        if gi in game_kifu or not g['win'] or not g['y'].isdigit():
            continue
        pair = frozenset([g['b'], g['w']])
        same_g = [gj for gj in g_pair_year[(pair, g['y'])] if tkey(games[gj]['ev']) == tkey(g['ev'])]
        tour_of = lambda k: ((k.get('series') or {}).get('tournament') or {}).get('name') or k.get('tournamentName') or ''
        same_k = [k for k in by_pair_year.get((pair, int(g['y'])), []) if same_tour(g['ev'], tour_of(k))]
        if len(same_g) != 1 or len(same_k) != 1:
            continue
        k = same_k[0]
        if k['id'] in used:
            continue
        hw = higo_winner(k)
        if hw is None or (k['_b'] if hw == 'B' else k['_w']) != g['win']:
            continue
        game_kifu[gi] = k['id']; used.add(k['id']); tier3 += 1

    mp = defaultdict(list)
    for gi in sorted(game_kifu):
        g = games[gi]
        mp['|'.join([g['y'], g['d'], g['b'], g['w']])].append(game_kifu[gi])

    per_year = defaultdict(lambda: [0, 0])
    for gi, g in enumerate(games):
        per_year[g['y']][1] += 1
        if gi in game_kifu: per_year[g['y']][0] += 1

    out = {'generated': datetime.datetime.now(TW).strftime('%Y-%m-%d %H:%M'),
           'higoCount': len(kifus), 'games': len(games), 'matched': len(game_kifu),
           'url': 'https://www.higohigo.org/#/kifu/',
           'map': dict(sorted(mp.items()))}
    txt = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    def same_as_old(p):  # 內容沒變（只差產生時間）就不重寫，GitHub 才不會每天白白發布一次
        try:
            with open(p, encoding='utf-8') as f:
                old = json.load(f)
        except Exception:
            return False
        old.pop('generated', None)
        return old == {k: v for k, v in out.items() if k != 'generated'}
    for p in OUTS:
        if os.path.isdir(os.path.dirname(p)):
            if same_as_old(p):
                print('  沒有變化，不用更新', p)
                continue
            with open(p, 'w', encoding='utf-8') as f:
                f.write(txt)
            print('  已寫入', p)

    print()
    print(f'完成：成績系統 {len(games):,} 局，配到 HiGO 棋譜 {len(game_kifu):,} 局（{len(game_kifu) / max(1, len(games)):.0%}，其中 {tier2:,} 局是 HiGO 日期差 2～10 天、{tier3:,} 局靠「同年同賽事只對一次」）')
    for y in sorted(per_year):
        a, n = per_year[y]
        print(f'  {y}：{a:>5,} / {n:>5,}  {a / n:.0%}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n⚠ 發生錯誤：', e)
        sys.exit(1)
