async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

function updateStatus(message) {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = message;
}

document.getElementById('start').onclick = async function() {
  const cpf = document.getElementById('cpf').value;
  const celular = document.getElementById('celular').value;
  const cidade = document.getElementById('cidade').value;
  updateStatus('Executando automacao...');

  const tabId = await getActiveTabId();
  if (!tabId) {
    updateStatus('Nao foi possivel identificar a aba ativa.');
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: (config) => window.inssAutoStart && window.inssAutoStart(config),
      args: [{ cpf, celular, cidade }]
    },
    () => {
      updateStatus('Automacao enviada para a pagina.');
    }
  );
};

document.getElementById('resume').onclick = async function() {
  updateStatus('Solicitando retomada...');
  const tabId = await getActiveTabId();
  if (!tabId) {
    updateStatus('Nao foi possivel identificar a aba ativa.');
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: () => {
        if (typeof window.inssAutoResume === 'function') {
          window.inssAutoResume('popup');
          return window.__inssAutomationStatus || 'Retomada solicitada.';
        }
        return 'Automacao nao inicializada nesta pagina.';
      }
    },
    (results) => {
      const result = results && results[0] ? results[0].result : '';
      updateStatus(result || 'Retomada enviada.');
    }
  );
};

document.getElementById('kill').onclick = async function() {
  updateStatus('Matando backdrops...');
  const tabId = await getActiveTabId();
  if (!tabId) {
    updateStatus('Nao foi possivel identificar a aba ativa.');
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: () => {
        if (typeof window.inssKillBackdrops === 'function') {
          window.inssKillBackdrops();
          return 'Backdrops removidos.';
        }
        return 'Funcao inssKillBackdrops indisponivel.';
      }
    },
    (results) => {
      const result = results && results[0] ? results[0].result : '';
      updateStatus(result || 'Comando enviado.');
    }
  );
};
