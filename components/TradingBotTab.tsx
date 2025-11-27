
import { useState, useEffect } from 'react';

interface TradingBotTabProps {
  broker: any;
  selectedProvider: any;
  message: string;
  setMessage: (message: string) => void;
}

interface MarketTicker {
  symbol: string;
  price: string;
}

export default function TradingBotTab({ 
  broker, 
  selectedProvider, 
  message, 
  setMessage 
}: TradingBotTabProps) {

  const [marketData, setMarketData] = useState<MarketTicker[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('BTCUSDT');
  const [aiSuggestion, setAiSuggestion] = useState<string>('');
  const [analyzingLoading, setAnalyzingLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 热门交易对列表
  const popularSymbols = ['0GUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'];

  // 获取币安市场数据
  const fetchMarketData = async () => {
    setLoading(true);
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
      const data = await response.json();
      
      // 只显示热门交易对
      const filtered = data.filter((ticker: MarketTicker) => 
        popularSymbols.includes(ticker.symbol)
      );
      
      setMarketData(filtered);
    } catch (err) {
      console.error('获取市场数据失败:', err);
      setMessage('获取市场数据失败');
    }
    setLoading(false);
  };

  // 自动刷新市场数据
  useEffect(() => {
    fetchMarketData();
    
    if (autoRefresh) {
      const interval = setInterval(fetchMarketData, 10000); // 每10秒刷新一次
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  // 获取 AI 交易建议
  const getAISuggestion = async () => {
    if (!broker || !selectedProvider || !selectedSymbol) {
      setMessage('请先选择并验证服务');
      return;
    }

    setAnalyzingLoading(true);
    setAiSuggestion('');
    
    try {
      // 1. 首先检查服务是否已验证
      console.log('检查服务验证状态...');
      let isAcknowledged = false;
      try {
        isAcknowledged = await broker.inference.userAcknowledged(selectedProvider.address);
        console.log('服务验证状态:', isAcknowledged);
      } catch (err) {
        console.error('检查验证状态失败:', err);
      }

      if (!isAcknowledged) {
        setMessage('错误: 服务未验证，请先在"服务"标签页验证服务');
        setAnalyzingLoading(false);
        return;
      }

      // 2. 检查主账户余额
      console.log('检查主账户余额...');
      let ledgerData;
      try {
        ledgerData = await broker.ledger.ledger.getLedgerWithDetail();
        console.log('主账户完整数据:', ledgerData);
      } catch (err) {
        console.error('获取账户信息失败:', err);
        setMessage('错误: 无法获取主账户信息，请先在"账户"标签页创建账本');
        setAnalyzingLoading(false);
        return;
      }
      
      // 检查数据结构 - 根据 AccountTab 的实现，ledgerInfo 是数组
      if (!ledgerData?.ledgerInfo || !Array.isArray(ledgerData.ledgerInfo)) {
        console.error('账户数据结构异常:', ledgerData);
        setMessage('错误: 账户数据结构异常，请先在"账户"标签页创建账本');
        setAnalyzingLoading(false);
        return;
      }
      
      const { ledgerInfo } = ledgerData;
      const totalBalance = BigInt(ledgerInfo[0] || 0);
      console.log('主账户余额:', totalBalance.toString());
      
      if (totalBalance < BigInt(1e18)) {
        setMessage('错误: 主账户余额不足，请先在"账户"标签页充值');
        setAnalyzingLoading(false);
        return;
      }

      // 3. 检查并充值子账户
      console.log('检查子账户...');
      let account;
      try {
        account = await broker.inference.getAccount(selectedProvider.address);
        console.log('子账户信息:', account);
        
        // 安全检查 account.balance
        if (account?.balance) {
          console.log('子账户余额:', account.balance.toString());
          
          if (account.balance <= BigInt(1.5e18)) {
            console.log("子账户余额不足，正在充值...");
            setMessage('正在充值子账户...');
            await broker.ledger.transferFund(
              selectedProvider.address,
              "inference",
              BigInt(2e18)
            );
            console.log('子账户充值成功');
          }
        } else {
          throw new Error('子账户余额信息无效');
        }
      } catch (error) {
        console.log('子账户不存在，正在创建并充值...');
        setMessage('正在创建子账户...');
        try {
          await broker.ledger.transferFund(
            selectedProvider.address,
            "inference",
            BigInt(2e18)
          );
          console.log('子账户创建并充值成功');
        } catch (transferErr) {
          console.error('创建子账户失败:', transferErr);
          setMessage('错误: 创建子账户失败 - ' + (transferErr instanceof Error ? transferErr.message : String(transferErr)));
          setAnalyzingLoading(false);
          return;
        }
      }

      // 4. 获取选中交易对的当前价格
      const currentTicker = marketData.find(t => t.symbol === selectedSymbol);
      const currentPrice = currentTicker?.price || 'N/A';

      // 5. 构建提示词
      const prompt = `作为一个专业的加密货币交易分析师，请分析 ${selectedSymbol} 交易对的当前情况。

当前价格: ${currentPrice} USDT

请提供：
1. 技术分析观点（支撑位、阻力位）
2. 短期交易建议（做多/做空/观望）
3. 风险提示

请用简洁专业的语言回答，不超过200字。`;

      const userMsg = { role: "user", content: prompt };

      // 6. 获取服务元数据和请求头
      console.log('获取服务元数据...');
      setMessage('正在获取 AI 分析...');
      const metadata = await broker.inference.getServiceMetadata(selectedProvider.address);
      const headers = await broker.inference.getRequestHeaders(
        selectedProvider.address,
        JSON.stringify([userMsg])
      );

      // 7. 发送请求到 AI 服务
      console.log('发送请求到 AI 服务...');
      const response = await fetch(`${metadata.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          messages: [userMsg],
          model: metadata.model,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`AI 服务响应错误: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.choices || !result.choices[0] || !result.choices[0].message) {
        throw new Error('AI 服务返回数据格式错误');
      }

      const aiResponse = result.choices[0].message.content;
      setAiSuggestion(aiResponse);

      // 8. 处理验证和计费
      if (result.id) {
        console.log('处理响应验证...');
        setMessage('验证 AI 响应中...');
        try {
          await broker.inference.processResponse(
            selectedProvider.address,
            aiResponse,
            result.id
          );
          setMessage("✅ AI 分析完成并已验证");
          console.log('响应验证成功');
        } catch (verifyErr) {
          console.error("验证失败:", verifyErr);
          setMessage("⚠️ AI 分析完成，但验证失败: " + (verifyErr instanceof Error ? verifyErr.message : String(verifyErr)));
        }
      } else {
        setMessage("✅ AI 分析完成");
      }
    } catch (err) {
      console.error('AI 分析失败:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      // 提供更友好的错误提示
      if (errorMsg.includes('missing revert data')) {
        setMessage('❌ 合约调用失败: 请确保已在"服务"标签页验证服务，并在"账户"标签页充值账户');
      } else if (errorMsg.includes('insufficient funds')) {
        setMessage('❌ 余额不足: 请在"账户"标签页充值');
      } else if (errorMsg.includes('not acknowledged')) {
        setMessage('❌ 服务未验证: 请先在"服务"标签页验证服务');
      } else {
        setMessage('❌ AI 分析失败: ' + errorMsg);
      }
    } finally {
      setAnalyzingLoading(false);
    }
  };

  return (
    <div>
      <h2>🤖 AI 交易机器人</h2>
      
      {/* 市场数据区域 */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '10px' 
        }}>
          <h3>市场数据</h3>
          <div>
            <label style={{ marginRight: '10px' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              {' '}自动刷新 (10秒)
            </label>
            <button
              onClick={fetchMarketData}
              disabled={loading}
              style={{ padding: '5px 15px' }}
            >
              {loading ? '加载中...' : '🔄 刷新'}
            </button>
          </div>
        </div>

        <table style={{ 
          width: '100%', 
          borderCollapse: 'collapse',
          border: '1px solid #ddd'
        }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ padding: '10px', textAlign: 'left', border: '1px solid #ddd' }}>交易对</th>
              <th style={{ padding: '10px', textAlign: 'right', border: '1px solid #ddd' }}>价格 (USDT)</th>
              <th style={{ padding: '10px', textAlign: 'center', border: '1px solid #ddd' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {marketData.length > 0 ? (
              marketData.map((ticker) => (
                <tr 
                  key={ticker.symbol}
                  style={{ 
                    background: selectedSymbol === ticker.symbol ? '#e3f2fd' : 'white'
                  }}
                >
                  <td style={{ padding: '10px', border: '1px solid #ddd', fontWeight: 'bold' }}>
                    {ticker.symbol}
                  </td>
                  <td style={{ 
                    padding: '10px', 
                    border: '1px solid #ddd', 
                    textAlign: 'right',
                    fontFamily: 'monospace',
                    fontSize: '16px'
                  }}>
                    ${parseFloat(ticker.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td style={{ padding: '10px', border: '1px solid #ddd', textAlign: 'center' }}>
                    <button
                      onClick={() => setSelectedSymbol(ticker.symbol)}
                      style={{
                        padding: '5px 10px',
                        background: selectedSymbol === ticker.symbol ? '#007bff' : '#6c757d',
                        color: 'white',
                        border: 'none',
                        cursor: 'pointer',
                        borderRadius: '3px'
                      }}
                    >
                      {selectedSymbol === ticker.symbol ? '✓ 已选择' : '选择'}
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={3} style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  {loading ? '加载市场数据中...' : '暂无数据'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* AI 分析区域 */}
      <div style={{
        border: '1px solid #ddd',
        padding: '15px',
        borderRadius: '5px',
        background: '#f9f9f9'
      }}>
        <h3>AI 交易分析</h3>
        
        {!selectedProvider ? (
          <p style={{ color: '#dc3545' }}>⚠️ 请先在"服务"标签页选择并验证 AI 服务提供者</p>
        ) : (
          <>
            <div style={{ marginBottom: '15px' }}>
              <p style={{ marginBottom: '5px' }}>
                <strong>选中交易对:</strong> {selectedSymbol}
              </p>
              <p style={{ marginBottom: '5px', fontSize: '14px', color: '#666' }}>
                <strong>AI 服务:</strong> {selectedProvider.name} - {selectedProvider.model}
              </p>
            </div>

            <button
              onClick={getAISuggestion}
              disabled={analyzingLoading || !selectedSymbol}
              style={{
                padding: '10px 20px',
                background: analyzingLoading ? '#6c757d' : '#28a745',
                color: 'white',
                border: 'none',
                cursor: analyzingLoading ? 'not-allowed' : 'pointer',
                borderRadius: '5px',
                fontSize: '16px',
                fontWeight: 'bold'
              }}
            >
              {analyzingLoading ? '🔄 AI 分析中...' : '🚀 获取 AI 交易建议'}
            </button>

            {aiSuggestion && (
              <div style={{
                marginTop: '15px',
                padding: '15px',
                background: 'white',
                border: '1px solid #28a745',
                borderRadius: '5px'
              }}>
                <h4 style={{ marginTop: 0, color: '#28a745' }}>💡 AI 交易建议</h4>
                <div style={{ 
                  whiteSpace: 'pre-wrap',
                  lineHeight: '1.6',
                  fontSize: '14px'
                }}>
                  {aiSuggestion}
                </div>
                <p style={{ 
                  marginTop: '15px', 
                  fontSize: '12px', 
                  color: '#dc3545',
                  fontStyle: 'italic'
                }}>
                  ⚠️ 免责声明：以上建议仅供参考，不构成投资建议。加密货币交易有风险，请谨慎决策。
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
