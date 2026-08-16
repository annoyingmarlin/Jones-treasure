/* =========================================================
   DAVY JONES SUNKEN TREASURE — GAME ENGINE
   Organized into separate modules (each an object literal)
   instead of one giant function, per the architecture:

     Config            - shared sizing/layout constants
     Symbols           - the symbol dictionary + weighted pools
     ReelEngine        - builds the 5 continuous reel columns
                          and animates them
     Paylines          - the data-driven payline definitions
     WinEvaluator      - reads a result grid + paylines, wild
                          substitution, returns winnings
     GameState         - the base/bonus/chest state machine +
                          spin-lock so you can't double-spin
     BonusGame         - shovel collection, spin counter,
                          chest reveal
     UI                - DOM wiring or existing buttons/lever/
                          readouts (unchanged from before)

   The 5x4 reel change: each column is now ONE reel-window
   containing ONE reel-strip. The strip holds a run of random
   filler symbols followed by the 4 final symbols; animating
   translateY moves the WHOLE column, so all 4 visible cells
   scroll together as a single reel, matching a real slot
   machine, instead of 4 separate mini-reels stacked up.
   ========================================================= */

(function(){

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
var Config = {
  COLS: 5,
  ROWS: 4,
  CELL_H: 64,        // must match .symbol / .reel-window CSS
  STRIP_LEN: 26,      // total symbols scrolled per spin (incl. the 4 final ones)
  CLAM_TRIGGER_COUNT: 6,
  BONUS_START_SPINS: 6,
  BONUS_EXTEND_SHOVELS: 3,   // shovels in one bonus spin needed to award +1 spin
  CHEST_VALUES: { silver: 8, gold: 20, diamond: 50 }, // multiplied by the bet that triggered the bonus

  // ---- Credits <-> real-money conversion ----
  // 10 credits = $1. Every credit amount on screen (balance,
  // bet, wins) is still tracked internally as credits; use
  // Config.formatDollars() wherever a $ readout is needed.
  CREDITS_PER_DOLLAR: 10,
  MAX_BET_DOLLARS: 250,
  BET_STEP_CREDITS: 50,   // how much each Bet Up/Down click moves (=$5)

  formatDollars: function(credits){
    return '$' + (credits / Config.CREDITS_PER_DOLLAR).toFixed(2);
  }
};
Config.MAX_BET_CREDITS = Config.MAX_BET_DOLLARS * Config.CREDITS_PER_DOLLAR; // 2500 credits = $250

// ---------------------------------------------------------
// SYMBOLS
// Central dictionary so every other module (reels, paylines,
// bonus tracking) refers to symbols by id, not raw emoji.
// Adding a new symbol later = one new entry here + weight
// entries in the pools below.
// ---------------------------------------------------------
var Symbols = {
  dict: {
    anchor:   {id:'anchor',   e:'⚓',                 type:'normal', val:2},
    shark:    {id:'shark',    e:'🦈',                 type:'normal', val:3},
    octopus:  {id:'octopus',  e:'🐙',                 type:'normal', val:5},
    moneybag: {id:'moneybag', e:'💰',                 type:'normal', val:8},
    gem:      {id:'gem',      e:'💎',                 type:'normal', val:15},
    flag:     {id:'flag',     e:'🏴\u200d☠️',         type:'normal', val:30},
    wild:     {id:'wild',     e:'🔱',                 type:'wild',   val:30}, // val used only if a line is entirely wild
    clam:     {id:'clam',     e:'🦪',                 type:'bonus',  val:0},  // scatter — triggers the bonus, doesn't pay lines
    shovel:   {id:'shovel',   e:'⛏️',                 type:'shovel', val:0}   // bonus-game-only symbol
  },

  // Weighted pool for the BASE game reels.
  basePool: [
    {id:'anchor',   w:10},
    {id:'shark',    w:8},
    {id:'octopus',  w:6},
    {id:'moneybag', w:4},
    {id:'gem',      w:2},
    {id:'flag',     w:1},
    {id:'wild',     w:3},
    {id:'clam',     w:4.4}
  ],

  // Weighted pool for BONUS game reels: normal symbols as
  // filler, plus the rare shovel. No wild/clam during bonus.
  bonusPool: [
    {id:'anchor',   w:10},
    {id:'shark',    w:8},
    {id:'octopus',  w:6},
    {id:'moneybag', w:4},
    {id:'gem',      w:2},
    {id:'flag',     w:1},
    {id:'shovel',   w:1.4}
  ],

  pick: function(pool){
    var total = pool.reduce(function(s,x){return s+x.w;},0);
    var r = Math.random() * total;
    for (var i=0;i<pool.length;i++){
      r -= pool[i].w;
      if (r <= 0) return pool[i].id;
    }
    return pool[0].id;
  },

  get: function(id){ return this.dict[id]; }
};

// ---------------------------------------------------------
// PAYLINES (data-driven — add/remove/edit lines here only)
// Each line is 5 row indices (0-3), one per reel, left to
// right. Straight lines, V/inverted-V, and zigzags are all
// just different row sequences.
// ---------------------------------------------------------
var Paylines = {
  lines: [
    {id:'top',        rows:[0,0,0,0,0]},
    {id:'upper-mid',  rows:[1,1,1,1,1]},
    {id:'lower-mid',  rows:[2,2,2,2,2]},
    {id:'bottom',     rows:[3,3,3,3,3]},
    {id:'v-shape',    rows:[0,1,3,1,0]},
    {id:'inverted-v', rows:[3,2,0,2,3]},
    {id:'zigzag',     rows:[0,3,0,3,0]},
    {id:'w-shape',    rows:[3,0,3,0,3]}
  ]
};

// ---------------------------------------------------------
// WIN EVALUATOR
// grid[row][col] = symbolId, 4 rows x 5 cols.
// ---------------------------------------------------------
var WinEvaluator = {
  countMult: {3:1, 4:2.5, 5:6},

  evaluate: function(grid, bet){
    var lineStake = bet / Paylines.lines.length; // bet is spread across all active lines
    var total = 0;
    var winningLines = []; // [{lineId, count, symbolId, amount, cells:[{row,col}]}]

    Paylines.lines.forEach(function(line){
      var seq = line.rows.map(function(row, col){ return grid[row][col]; });

      // Winning symbol = first NON-wild, NON-bonus/shovel symbol in the sequence.
      var winId = null;
      for (var i=0;i<seq.length;i++){
        var sym = Symbols.get(seq[i]);
        if (sym.type === 'normal'){ winId = seq[i]; break; }
      }
      if (!winId) winId = 'wild'; // an all-wild run pays as wild

      var count = 0;
      for (var j=0;j<seq.length;j++){
        var s = Symbols.get(seq[j]);
        if (seq[j] === winId || s.type === 'wild') count++;
        else break;
      }

      if (count >= 3){
        var payVal = Symbols.get(winId).val;
        var mult = WinEvaluator.countMult[count] || 0;
        var amount = Math.round(lineStake * payVal * mult);
        if (amount > 0){
          total += amount;
          var cells = [];
          for (var c=0;c<count;c++) cells.push({row:line.rows[c], col:c});
          winningLines.push({lineId:line.id, count:count, symbolId:winId, amount:amount, cells:cells});
        }
      }
    });

    return {total: Math.round(total), lines: winningLines};
  },

  countClams: function(grid){
    var n = 0;
    for (var r=0;r<Config.ROWS;r++)
      for (var c=0;c<Config.COLS;c++)
        if (grid[r][c] === 'clam') n++;
    return n;
  },

  countShovels: function(grid){
    var n = 0;
    for (var r=0;r<Config.ROWS;r++)
      for (var c=0;c<Config.COLS;c++)
        if (grid[r][c] === 'shovel') n++;
    return n;
  }
};

// ---------------------------------------------------------
// REEL ENGINE
// Builds the DOM for 5 continuous reel columns and animates
// them. Each column = one .reel-window (clips to 4 visible
// cells) containing one .reel-strip that gets translateY'd.
// A separate, non-scrolling .cell-frames overlay sits on top
// of each column for win highlights / shovel borders, since
// those need to stay fixed to a screen position, not scroll
// with the strip.
// ---------------------------------------------------------
var ReelEngine = {
  strips: [],       // strips[col] = the .reel-strip element
  frames: [],       // frames[col][row] = the .cell-frame element
  currentGrid: [],  // currentGrid[row][col] = symbolId, always reflects what's on screen at rest

  buildDOM: function(){
    var gridEl = document.getElementById('reelsGrid');
    gridEl.innerHTML = '';
    this.strips = [];
    this.frames = [];

    for (var c=0;c<Config.COLS;c++){
      var col = document.createElement('div');
      col.className = 'reel-col';

      var win = document.createElement('div');
      win.className = 'reel-window';

      var strip = document.createElement('div');
      strip.className = 'reel-strip';
      strip.id = 'reelStrip'+c;
      win.appendChild(strip);

      var frameWrap = document.createElement('div');
      frameWrap.className = 'cell-frames';
      var colFrames = [];
      for (var r=0;r<Config.ROWS;r++){
        var frame = document.createElement('div');
        frame.className = 'cell-frame';
        frame.dataset.row = r;
        frame.dataset.col = c;
        frameWrap.appendChild(frame);
        colFrames.push(frame);
      }
      win.appendChild(frameWrap);

      col.appendChild(win);
      gridEl.appendChild(col);

      this.strips.push(strip);
      this.frames.push(colFrames);
    }
  },

  symbolEl: function(id){
    var sym = Symbols.get(id);
    var div = document.createElement('div');
    div.className = 'symbol sym-' + sym.type;
    div.textContent = sym.e;
    return div;
  },

  // Fills every column with resting (non-animated) symbols —
  // used on page load and right after the bonus game ends.
  fillAtRest: function(pool){
    var grid = [];
    for (var r=0;r<Config.ROWS;r++) grid.push([]);

    for (var c=0;c<Config.COLS;c++){
      var strip = this.strips[c];
      strip.innerHTML = '';
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0px)';
      for (var r2=0;r2<Config.ROWS;r2++){
        var id = Symbols.pick(pool);
        grid[r2][c] = id;
        strip.appendChild(this.symbolEl(id));
      }
    }
    this.currentGrid = grid;
    this.clearAllFrameStates();
  },

  // Spins every column to a freshly-rolled grid, columns
  // settling left-to-right. Calls onDone(grid) once every
  // column has stopped.
  spinToNewGrid: function(pool, onDone){
    var self = this;
    var grid = [];
    for (var r=0;r<Config.ROWS;r++){
      grid.push([]);
      for (var c=0;c<Config.COLS;c++) grid[r].push(Symbols.pick(pool));
    }

    var pending = Config.COLS;
    for (var c=0;c<Config.COLS;c++){
      (function(col){
        var duration = 900 + col*280; // left-to-right settle, same feel as before
        var finalCol = [];
        for (var r=0;r<Config.ROWS;r++) finalCol.push(grid[r][col]);
        self.spinColumn(col, finalCol, duration, function(){
          pending--;
          if (pending === 0){
            self.currentGrid = grid;
            onDone(grid);
          }
        });
      })(c);
    }
  },

  spinColumn: function(col, finalSymbols, duration, onDone){
    var strip = this.strips[col];
    var fillerCount = Config.STRIP_LEN - Config.ROWS;
    var ids = [];
    for (var i=0;i<fillerCount;i++) ids.push(Symbols.pick(Symbols.basePool));
    finalSymbols.forEach(function(id){ ids.push(id); });

    strip.innerHTML = '';
    var self = this;
    ids.forEach(function(id){ strip.appendChild(self.symbolEl(id)); });

    var travel = fillerCount * Config.CELL_H;
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0px)';
    void strip.offsetHeight; // force reflow so the transition actually animates
    strip.style.transition = 'transform ' + duration + 'ms cubic-bezier(.15,.7,.25,1)';
    strip.style.transform = 'translateY(-' + travel + 'px)';

    setTimeout(onDone, duration);
  },

  clearAllFrameStates: function(){
    this.frames.forEach(function(col){
      col.forEach(function(f){
        f.className = 'cell-frame';
      });
    });
  },

  highlightWinCells: function(lines){
    lines.forEach(function(line){
      line.cells.forEach(function(cell){
        ReelEngine.frames[cell.col][cell.row].classList.add('win-highlight');
      });
    });
  },

  clearWinHighlights: function(){
    this.frames.forEach(function(col){
      col.forEach(function(f){ f.classList.remove('win-highlight'); });
    });
  }
};

// ---------------------------------------------------------
// GAME STATE
// Single source of truth for what the game is currently
// doing, and the lock that keeps the player from spinning
// mid-animation.
// ---------------------------------------------------------
var GameState = {
  mode: 'base', // 'base' | 'clamAnim' | 'bonusSpinning' | 'bonusResolving' | 'chestReveal'
  spinning: false,
  balance: 10000, // 10,000 credits = $1,000 at 10 credits/$1
  bet: 50,        // 50 credits = $5 starting bet

  isLocked: function(){
    return this.spinning || this.mode !== 'base' && this.mode !== 'bonusReady';
  }
};

// ---------------------------------------------------------
// BONUS GAME
// ---------------------------------------------------------
var BonusGame = {
  active: false,
  spinsLeft: 0,
  triggerBet: 5,
  totalWin: 0,
  windows: [], // windows[row*COLS+col] = {level:0-3}  0=normal,1=silver,2=gold,3=diamond
  levelNames: ['normal','silver','gold','diamond'],

  reset: function(){
    this.windows = [];
    for (var i=0;i<Config.COLS*Config.ROWS;i++) this.windows.push({level:0});
    this.totalWin = 0;
  },

  start: function(triggerBet){
    this.active = true;
    this.spinsLeft = Config.BONUS_START_SPINS;
    this.triggerBet = triggerBet;
    this.reset();

    document.getElementById('bonusOverlay').classList.remove('hidden');
    document.getElementById('bonusSpinsLeft').textContent = this.spinsLeft;
    UI.setMessage('Bonus game! ' + this.spinsLeft + ' spins — find shovels.', true);

    GameState.mode = 'bonusReady';
    UI.updateLockState();
  },

  windowIndex: function(row,col){ return row*Config.COLS + col; },

  // Runs one bonus spin: spins the reels with the bonus pool,
  // upgrades any windows that landed a shovel, checks the
  // spin-extension rule, then either sets up the next spin or
  // moves to the chest reveal.
  doSpin: function(){
    if (GameState.isLocked()) return;
    GameState.spinning = true;
    GameState.mode = 'bonusSpinning';
    UI.updateLockState();
    UI.setMessage('Digging…');

    ReelEngine.spinToNewGrid(Symbols.bonusPool, function(grid){
      var shovelCount = 0;
      for (var r=0;r<Config.ROWS;r++){
        for (var c=0;c<Config.COLS;c++){
          if (grid[r][c] === 'shovel'){
            shovelCount++;
            var idx = BonusGame.windowIndex(r,c);
            var w = BonusGame.windows[idx];
            w.level = Math.min(3, w.level + 1);
            var frame = ReelEngine.frames[c][r];
            frame.classList.remove('lvl-silver','lvl-gold','lvl-diamond');
            frame.classList.add('lvl-' + BonusGame.levelNames[w.level]);
            frame.classList.add('digging');
            setTimeout((function(f){ return function(){ f.classList.remove('digging'); }; })(frame), 420);
          }
        }
      }

      BonusGame.spinsLeft--;

      var notice = document.getElementById('bonusNotice');
      if (shovelCount >= Config.BONUS_EXTEND_SHOVELS){
        BonusGame.spinsLeft++;
        notice.textContent = shovelCount + ' shovels! +1 bonus spin';
        notice.classList.remove('hidden');
        setTimeout(function(){ notice.classList.add('hidden'); }, 1400);
      }

      document.getElementById('bonusSpinsLeft').textContent = Math.max(0, BonusGame.spinsLeft);
      GameState.spinning = false;

      if (BonusGame.spinsLeft <= 0){
        GameState.mode = 'chestReveal';
        UI.updateLockState();
        setTimeout(function(){ BonusGame.revealChests(); }, 500);
      } else {
        GameState.mode = 'bonusReady';
        UI.updateLockState();
        UI.setMessage((BonusGame.spinsLeft) + ' bonus spins left');
      }
    });
  },

  revealChests: function(){
    // Grey out every window that never earned a border.
    ReelEngine.frames.forEach(function(col, c){
      col.forEach(function(frame, r){
        var idx = BonusGame.windowIndex(r,c);
        if (BonusGame.windows[idx].level === 0){
          frame.classList.add('dimmed');
        } else {
          frame.classList.add('earned');
        }
      });
    });

    var earned = [];
    this.windows.forEach(function(w, idx){
      if (w.level > 0) earned.push({idx:idx, level:w.level});
    });
    earned.sort(function(a,b){ return a.level - b.level; }); // silver -> gold -> diamond

    var chestList = document.getElementById('chestList');
    var chestTotalEl = document.getElementById('chestTotal');
    var reveal = document.getElementById('chestReveal');
    chestList.innerHTML = '';
    reveal.classList.remove('hidden');

    var i = 0;
    function revealNext(){
      if (i >= earned.length){
        chestTotalEl.textContent = BonusGame.totalWin + ' (' + Config.formatDollars(BonusGame.totalWin) + ')';
        GameState.balance += BonusGame.totalWin;
        UI.updateReadouts();
        UI.setMessage('Bonus complete! +' + BonusGame.totalWin + ' credits (' + Config.formatDollars(BonusGame.totalWin) + ')', true);
        setTimeout(function(){ BonusGame.finish(); }, 1800);
        return;
      }
      var item = earned[i];
      var levelName = BonusGame.levelNames[item.level];
      var value = Math.round(Config.CHEST_VALUES[levelName] * BonusGame.triggerBet);
      BonusGame.totalWin += value;

      var chestEl = document.createElement('div');
      chestEl.className = 'chest-item chest-' + levelName;
      chestEl.innerHTML = '<span class="chest-icon">' + (levelName==='diamond' ? '💎' : levelName==='gold' ? '🥇' : '🥈') + '</span><span class="chest-val">+' + value + ' (' + Config.formatDollars(value) + ')</span>';
      chestList.appendChild(chestEl);

      i++;
      setTimeout(revealNext, 550);
    }
    revealNext();
  },

  finish: function(){
    this.active = false;
    document.getElementById('bonusOverlay').classList.add('hidden');
    document.getElementById('chestReveal').classList.add('hidden');
    ReelEngine.clearAllFrameStates();
    GameState.mode = 'base';
    ReelEngine.fillAtRest(Symbols.basePool);
    UI.updateLockState();
    UI.setMessage('Pull the lever or press spin');
  }
};

// ---------------------------------------------------------
// CLAM OPENING ANIMATION (base game -> bonus game transition)
// ---------------------------------------------------------
var ClamSequence = {
  play: function(clamCount, onDone){
    GameState.mode = 'clamAnim';
    UI.updateLockState();

    var overlay = document.getElementById('clamOverlay');
    overlay.innerHTML = '';
    overlay.classList.remove('hidden');

    var icons = [];
    for (var i=0;i<clamCount;i++){
      var span = document.createElement('span');
      span.className = 'clam-icon';
      span.textContent = '🦪';
      overlay.appendChild(span);
      icons.push(span);
    }

    // Pop each clam open in sequence, revealing a pearl.
    icons.forEach(function(icon, idx){
      setTimeout(function(){
        icon.textContent = '🦪✨';
        icon.classList.add('opened');
        setTimeout(function(){ icon.textContent = '🫧🤍'; }, 180);
      }, idx * 160);
    });

    var totalDuration = clamCount * 160 + 700;
    setTimeout(function(){
      overlay.classList.add('hidden');
      onDone();
    }, totalDuration);
  }
};

// ---------------------------------------------------------
// UI — wires up the existing readouts/buttons/lever, same
// theme and elements as before.
// ---------------------------------------------------------
var UI = {
  els: {},

  cache: function(){
    this.els.balance = document.getElementById('balance');
    this.els.betDisplay = document.getElementById('betDisplay');
    this.els.betMini = document.getElementById('betMini');
    this.els.message = document.getElementById('message');
    this.els.spinBtn = document.getElementById('spinBtn');
    this.els.betUp = document.getElementById('betUp');
    this.els.betDown = document.getElementById('betDown');
    this.els.leverWrap = document.getElementById('leverWrap');
    this.els.leverStick = document.getElementById('leverStick');
  },

  updateReadouts: function(){
    this.els.balance.textContent = Math.round(GameState.balance);
    this.els.betDisplay.textContent = GameState.bet;
    this.els.betMini.textContent = GameState.bet;
  },

  setMessage: function(text, isWin){
    this.els.message.textContent = text;
    this.els.message.className = 'message' + (isWin === false ? ' lose' : '');
  },

  updateLockState: function(){
    var locked = GameState.spinning || (GameState.mode !== 'base' && GameState.mode !== 'bonusReady');
    this.els.spinBtn.disabled = locked;
    this.els.betUp.disabled = locked;
    this.els.betDown.disabled = locked;
  },

  adjustBet: function(delta){
    if (GameState.isLocked()) return;
    var next = GameState.bet + delta;
    if (next < 1) next = 1;
    if (next > GameState.balance) next = Math.max(1, GameState.balance);
    if (next > Config.MAX_BET_CREDITS) next = Config.MAX_BET_CREDITS;
    GameState.bet = next;
    this.updateReadouts();
  },

  bindEvents: function(){
    var self = this;
    this.els.betUp.addEventListener('click', function(){ self.adjustBet(Config.BET_STEP_CREDITS); });
    this.els.betDown.addEventListener('click', function(){ self.adjustBet(-Config.BET_STEP_CREDITS); });
    this.els.spinBtn.addEventListener('click', function(){ Game.requestSpin(); });

    var leverActive = false;
    function pullLever(){
      if (leverActive) return;
      leverActive = true;
      self.els.leverStick.className = 'lever-stick pulled';
      setTimeout(function(){
        self.els.leverStick.className = 'lever-stick reset';
        Game.requestSpin();
      }, 180);
      setTimeout(function(){ leverActive = false; }, 700);
    }
    this.els.leverWrap.addEventListener('click', pullLever);
    this.els.leverWrap.addEventListener('touchstart', function(e){ e.preventDefault(); pullLever(); }, {passive:false});
  }
};

// ---------------------------------------------------------
// GAME — top-level dispatcher tying the base game and bonus
// game spin actions to the one Spin button / lever.
// ---------------------------------------------------------
var Game = {
  requestSpin: function(){
    if (GameState.mode === 'bonusReady'){
      BonusGame.doSpin();
      return;
    }
    if (GameState.mode === 'base') this.doBaseSpin();
  },

  doBaseSpin: function(){
    if (GameState.isLocked()) return;
    if (GameState.balance < GameState.bet){
      UI.setMessage('Not enough credits — lower your bet', false);
      return;
    }

    GameState.spinning = true;
    UI.updateLockState();
    GameState.balance -= GameState.bet;
    UI.updateReadouts();
    UI.setMessage('Spinning…');
    ReelEngine.clearWinHighlights();

    var betAtSpinTime = GameState.bet;

    ReelEngine.spinToNewGrid(Symbols.basePool, function(grid){
      GameState.spinning = false;

      var result = WinEvaluator.evaluate(grid, betAtSpinTime);
      var clamCount = WinEvaluator.countClams(grid);

      if (result.total > 0){
        GameState.balance += result.total;
        ReelEngine.highlightWinCells(result.lines);
        UI.setMessage('Winner! +' + result.total, true);
      } else {
        UI.setMessage('No match — spin again', false);
      }
      UI.updateReadouts();

      if (GameState.balance <= 0 && clamCount < Config.CLAM_TRIGGER_COUNT){
        GameState.balance = 1000; // 1,000 credits = $100
        GameState.bet = Math.min(GameState.bet, 50); // cap bet back down to $5
        UI.updateReadouts();
        UI.setMessage('Out of credits — resetting to ' + GameState.balance + ' (' + Config.formatDollars(GameState.balance) + ')', false);
      }

      if (clamCount >= Config.CLAM_TRIGGER_COUNT){
        GameState.mode = 'clamAnim'; // lock immediately so a click during the brief pause can't sneak in another spin
        UI.updateLockState();
        setTimeout(function(){
          ClamSequence.play(clamCount, function(){
            BonusGame.start(betAtSpinTime);
          });
        }, 500);
      } else {
        GameState.mode = 'base';
        UI.updateLockState();
      }
    });
  }
};

// ---------------------------------------------------------
// BOOT
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', function(){
  UI.cache();
  ReelEngine.buildDOM();
  ReelEngine.fillAtRest(Symbols.basePool);
  UI.bindEvents();
  UI.updateReadouts();
  UI.updateLockState();
});

})();
