// src/core/propFirmManager.js
import { DateTime } from 'luxon';

const NY_ZONE = 'America/New_York';

export function getTradingDayKey(dtNY) {
  // Reset time is 5:00 PM EST (17:00 NY time).
  // If it's 5 PM or later, it belongs to the next trading day.
  if (dtNY.hour >= 17) {
    return dtNY.plus({ days: 1 }).toFormat('yyyy-LL-dd');
  }
  return dtNY.toFormat('yyyy-LL-dd');
}

export class PropFirmManager {
  constructor({ db }) {
    this.db = db;
    this.collection = db ? db.collection('account_state') : null;
    this.tradesColl = db ? db.collection('trades') : null;
    this.account = null;
  }

  async init() {
    if (!this.collection) {
      this.account = this._getDefaultAccount();
      return;
    }

    let acc = await this.collection.findOne({ _id: 'active_account' });
    if (!acc) {
      acc = this._getDefaultAccount();
      await this.collection.insertOne(acc);
    }
    this.account = acc;
    console.log(`[PropFirmManager] Account initialized. Balance: $${this.account.balance.toFixed(2)}, Equity: $${this.account.equity.toFixed(2)}, Firm: ${this.account.firm}, Phase: ${this.account.phase}`);
  }

  _getDefaultAccount() {
    return {
      _id: 'active_account',
      firm: 'goat', // 'goat' or 'fundingpips'
      phase: 'phase1', // 'phase1', 'phase2', 'funded'
      initialBalance: 100000,
      balance: 100000,
      equity: 100000,
      highWatermark: 100000,
      failed: false,
      failReason: '',
      tradingDays: [],
      payouts: [],
      lastResetDateNY: getTradingDayKey(DateTime.now().setZone(NY_ZONE)),
      riskType: 'fixed_percent', // 'fixed_percent' or 'fixed_lots'
      riskPercent: 1.0,
      fixedLots: 2.0,
      dailyRealizedProfit: {}, // dateNY -> net profit closed on that day
      updatedAt: Date.now()
    };
  }

  getAccount() {
    return this.account || this._getDefaultAccount();
  }

  async save() {
    this.account.updatedAt = Date.now();
    if (this.collection) {
      await this.collection.updateOne(
        { _id: 'active_account' },
        { $set: this.account },
        { upsert: true }
      );
    }
  }

  async resetAccount(firm, initialBalance, riskType, riskPercent, fixedLots, phase) {
    const defaultAcc = this._getDefaultAccount();
    // Use nullish coalescing (??) so that valid falsy numbers (e.g. 0.5 risk%) are not
    // accidentally replaced by the default.
    const parsedBalance  = Number(initialBalance);
    const parsedRisk     = Number(riskPercent);
    const parsedLots     = Number(fixedLots);

    const safeBalance = (isFinite(parsedBalance) && parsedBalance > 0) ? parsedBalance : defaultAcc.initialBalance;
    const safeRisk    = isFinite(parsedRisk)  ? parsedRisk  : defaultAcc.riskPercent;
    const safeLots    = (isFinite(parsedLots) && parsedLots > 0) ? parsedLots : defaultAcc.fixedLots;

    this.account = {
      ...defaultAcc,
      firm:           firm     || defaultAcc.firm,
      phase:          phase    || defaultAcc.phase,
      initialBalance: safeBalance,
      balance:        safeBalance,
      equity:         safeBalance,
      highWatermark:  safeBalance,
      riskType:       riskType || defaultAcc.riskType,
      riskPercent:    safeRisk,
      fixedLots:      safeLots,
    };
    await this.save();
    console.log(`[PropFirmManager] Account reset. Balance: $${this.account.balance.toFixed(2)}, Firm: ${this.account.firm}, Phase: ${this.account.phase}`);
  }

  calculateLots(instrumentId, slPips) {
    const acc = this.getAccount();
    if (acc.riskType === 'fixed_lots') {
      let lots = acc.fixedLots || 2.0;
      if (acc.firm === 'fundingpips' && lots > 20) {
        lots = 20;
      }
      return lots;
    } else {
      // fixed_percent
      const riskAmount = acc.balance * ((acc.riskPercent || 1.0) / 100);
      const safeSlPips = slPips || 50;
      // 1 lot = $10 per pip for all pairs/Gold in our config
      let lots = riskAmount / (safeSlPips * 10);
      
      // Round to 2 decimal places
      lots = Math.round(lots * 100) / 100;
      if (lots < 0.01) lots = 0.01;

      // Limit to 20 lots if FundingPips
      if (acc.firm === 'fundingpips' && lots > 20) {
        lots = 20;
      }
      return lots;
    }
  }

  async checkDailyReset(dtNY) {
    const acc = this.getAccount();
    const currentTradingDay = getTradingDayKey(dtNY);
    if (acc.lastResetDateNY !== currentTradingDay) {
      console.log(`[PropFirmManager] Performing daily reset at 5 PM EST. Reset date: ${currentTradingDay}. Prev watermark: $${acc.highWatermark.toFixed(2)}, New watermark: $${Math.max(acc.balance, acc.equity).toFixed(2)}`);
      acc.highWatermark = Math.max(acc.balance, acc.equity);
      acc.lastResetDateNY = currentTradingDay;
      await this.save();
    }
  }

  async onTick(priceMap, openTrades) {
    const acc = this.getAccount();
    if (acc.failed) return;

    // Daily reset check
    const dtNY = DateTime.now().setZone(NY_ZONE);
    await this.checkDailyReset(dtNY);

    // Calculate current unrealized PnL
    let openPnL = 0;
    for (const t of openTrades) {
      const livePrice = priceMap.get(t.instrumentId);
      if (!livePrice) continue;

      const pipSize = t.pipSize || 0.0001;
      const diff = t.direction === 'buy' ? (livePrice - t.entryPrice) : (t.entryPrice - livePrice);
      const pips = diff / pipSize;
      const tradeLots = t.lots || 2.0;
      const pnl = pips * tradeLots * 10;
      openPnL += pnl;
    }

    acc.equity = acc.balance + openPnL;

    // Check Drawdowns
    // 1. Daily Drawdown (5%)
    const maxDailyDrawdown = acc.highWatermark * 0.05;
    const currentDailyDrawdown = acc.highWatermark - acc.equity;
    const currentDailyDrawdownBal = acc.highWatermark - acc.balance;

    if (currentDailyDrawdown > maxDailyDrawdown || currentDailyDrawdownBal > maxDailyDrawdown) {
      acc.failed = true;
      acc.failReason = `Daily drawdown limit (5% = $${maxDailyDrawdown.toFixed(2)}) breached. Current equity: $${acc.equity.toFixed(2)}, Balance: $${acc.balance.toFixed(2)}, High Watermark: $${acc.highWatermark.toFixed(2)}`;
      console.error(`[PropFirmManager] ${acc.failReason}`);
      await this.save();
      return;
    }

    // 2. Max Overall Drawdown (10% static of initial balance)
    const maxOverallDrawdown = acc.initialBalance * 0.10;
    const minEquityAllowed = acc.initialBalance - maxOverallDrawdown;

    if (acc.equity < minEquityAllowed || acc.balance < minEquityAllowed) {
      acc.failed = true;
      acc.failReason = `Max overall drawdown limit (10% static = $${maxOverallDrawdown.toFixed(2)}) breached. Min allowed: $${minEquityAllowed.toFixed(2)}, Current equity: $${acc.equity.toFixed(2)}, Balance: $${acc.balance.toFixed(2)}`;
      console.error(`[PropFirmManager] ${acc.failReason}`);
      await this.save();
      return;
    }

    // Save equity update
    await this.save();
  }

  async onTradeOpen(trade) {
    const acc = this.getAccount();
    if (acc.failed) {
      throw new Error("Cannot open trade: Account has failed.");
    }

    const dtNY = DateTime.now().setZone(NY_ZONE);
    const tradingDay = getTradingDayKey(dtNY);

    // Record trading day
    if (!acc.tradingDays.includes(tradingDay)) {
      acc.tradingDays.push(tradingDay);
      console.log(`[PropFirmManager] Registered new trading day: ${tradingDay}. Total trading days: ${acc.tradingDays.length}`);
    }

    await this.save();
  }

  async onTradeClose(tradeId, outcome, resultPips, tradeLots) {
    const acc = this.getAccount();
    if (acc.failed) return;

    const dtNY = DateTime.now().setZone(NY_ZONE);
    const tradingDay = getTradingDayKey(dtNY);

    const lots = tradeLots || 2.0;
    const rawPnL = resultPips * lots * 10;
    let actualPnL = rawPnL;

    // Apply Goat Daily realized profit cap ($3,000) on funded accounts
    if (acc.firm === 'goat' && acc.phase === 'funded' && rawPnL > 0) {
      if (!acc.dailyRealizedProfit) acc.dailyRealizedProfit = {};
      const todayProfit = acc.dailyRealizedProfit[tradingDay] || 0;
      
      const allowedProfit = Math.max(0, 3000 - todayProfit);
      actualPnL = Math.min(rawPnL, allowedProfit);
      
      acc.dailyRealizedProfit[tradingDay] = todayProfit + rawPnL;
      console.log(`[PropFirmManager] Goat Daily Profit Cap applied: rawPnL=$${rawPnL.toFixed(2)}, todayProfit=$${todayProfit.toFixed(2)}, allowedProfit=$${allowedProfit.toFixed(2)}, actualPnL=$${actualPnL.toFixed(2)}`);
    } else if (rawPnL < 0 && acc.firm === 'goat' && acc.phase === 'funded') {
      // Track losses for today's net profit cap calculation
      if (!acc.dailyRealizedProfit) acc.dailyRealizedProfit = {};
      const todayProfit = acc.dailyRealizedProfit[tradingDay] || 0;
      acc.dailyRealizedProfit[tradingDay] = todayProfit + rawPnL;
    }

    acc.balance += actualPnL;
    acc.equity = acc.balance; // since trade is closed, equity matches balance

    console.log(`[PropFirmManager] Trade closed: ${tradeId}. Outcome: ${outcome}, Pips: ${resultPips.toFixed(1)}, PnL: $${actualPnL.toFixed(2)}, New Balance: $${acc.balance.toFixed(2)}`);

    // Verify if profit target is met
    await this.evaluatePhaseTransition();

    // Check daily drawdown immediately on trade close (5% of watermark)
    const maxDailyDrawdown = acc.highWatermark * 0.05;
    const balanceDrawdown = acc.highWatermark - acc.balance;
    if (balanceDrawdown > maxDailyDrawdown) {
      acc.failed = true;
      acc.failReason = `Daily drawdown limit (5% = $${maxDailyDrawdown.toFixed(2)}) breached on close. Balance: $${acc.balance.toFixed(2)}, Watermark: $${acc.highWatermark.toFixed(2)}`;
      console.error(`[PropFirmManager] ${acc.failReason}`);
      await this.save();
      return;
    }

    // Check overall drawdown (10% static of initial balance)
    const maxOverallDrawdown = acc.initialBalance * 0.10;
    const minAllowed = acc.initialBalance - maxOverallDrawdown;
    if (acc.balance < minAllowed) {
      acc.failed = true;
      acc.failReason = `Overall drawdown breached on trade close. Balance: $${acc.balance.toFixed(2)}, limit: $${minAllowed.toFixed(2)}`;
      console.error(`[PropFirmManager] ${acc.failReason}`);
    }

    await this.save();
  }

  async evaluatePhaseTransition() {
    const acc = this.getAccount();
    if (acc.failed || acc.phase === 'funded') return;

    const profit = acc.balance - acc.initialBalance;
    const totalTradingDays = acc.tradingDays.length;

    let targetPct = 10;
    if (acc.phase === 'phase1') {
      targetPct = acc.firm === 'fundingpips' ? 10 : 10; // defaults to 10%
    } else if (acc.phase === 'phase2') {
      targetPct = 5; // 5% profit target for phase 2
    }

    const profitTarget = acc.initialBalance * (targetPct / 100);

    console.log(`[PropFirmManager] Checking phase eligibility: Profit: $${profit.toFixed(2)} (Target: $${profitTarget.toFixed(2)}), Trading Days: ${totalTradingDays} / 3`);

    // Min 3 trading days
    if (profit >= profitTarget && totalTradingDays >= 3) {
      if (acc.phase === 'phase1') {
        acc.phase = 'phase2';
        acc.balance = acc.initialBalance; // reset balance for Phase 2
        acc.equity = acc.initialBalance;
        acc.highWatermark = acc.initialBalance;
        acc.tradingDays = []; // reset trading days for the next phase
        console.log(`[PropFirmManager] PHASE 1 PASSED! Transitioned to Phase 2. Account balance reset to $${acc.balance.toFixed(2)}`);
      } else if (acc.phase === 'phase2') {
        acc.phase = 'funded';
        acc.balance = acc.initialBalance; // reset balance for Funded stage
        acc.equity = acc.initialBalance;
        acc.highWatermark = acc.initialBalance;
        acc.tradingDays = []; // reset trading days
        console.log(`[PropFirmManager] PHASE 2 PASSED! Account is now FUNDED! Balance reset to $${acc.balance.toFixed(2)}`);
      }
    }
  }

  async requestPayout() {
    const acc = this.getAccount();
    if (acc.failed || acc.phase !== 'funded') {
      throw new Error("Payouts are only available on active funded accounts.");
    }

    const profit = acc.balance - acc.initialBalance;
    if (profit <= 0) {
      throw new Error("No profit available for payout.");
    }

    // Check payout frequency rules (14 days since last payout or since funding)
    // For this simulation, we'll allow it if there are 3 trading days since the last payout
    const totalTradingDays = acc.tradingDays.length;
    if (totalTradingDays < 3) {
      throw new Error(`Minimum 3 trading days required before requesting a payout (Current: ${totalTradingDays}).`);
    }

    let payoutAmount = profit;
    const splitPct = acc.firm === 'goat' ? 80 : 90; // Goat = 80%, FundingPips = 90% (or up to 100%)
    
    // First two payouts cap for Goat: min of 6% of initial balance or $10,000
    const payoutCount = acc.payouts ? acc.payouts.length : 0;
    if (acc.firm === 'goat' && payoutCount < 2) {
      const cap = Math.min(acc.initialBalance * 0.06, 10000);
      if (payoutAmount > cap) {
        payoutAmount = cap;
        console.log(`[PropFirmManager] Payout capped for Goat Funded Trader (first two payouts limit: $${cap.toFixed(2)}). Original profit: $${profit.toFixed(2)}`);
      }
    }

    const splitPaid = payoutAmount * (splitPct / 100);
    const payoutRecord = {
      payoutNumber: payoutCount + 1,
      totalProfitRequested: profit,
      amountWithdrawn: payoutAmount,
      splitPct,
      splitPaid,
      timestamp: Date.now(),
      dateNY: getTradingDayKey(DateTime.now().setZone(NY_ZONE))
    };

    if (!acc.payouts) acc.payouts = [];
    acc.payouts.push(payoutRecord);

    // Reset balance back to initial
    acc.balance = acc.initialBalance;
    acc.equity = acc.initialBalance;
    acc.highWatermark = acc.initialBalance;
    acc.tradingDays = []; // reset trading days count for next payout
    acc.dailyRealizedProfit = {}; // reset daily realized profit caps

    await this.save();
    console.log(`[PropFirmManager] Payout processed successfully. Paid split: $${splitPaid.toFixed(2)}`);
    return payoutRecord;
  }
}
