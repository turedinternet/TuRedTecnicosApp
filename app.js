/* ==========================================================================
   LÓGICA PRINCIPAL (app.js) - TarifarioTuRed PWA
   Implementación Offline-First con Firebase / Fallback Local Mock
   ========================================================================== */

import firebaseConfig from './config.js';

// Importaciones dinámicas del SDK de Firebase desde CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  deleteDoc,
  getDoc, 
  getDocs, 
  enableIndexedDbPersistence,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

// --- ESTADO GLOBAL DE LA APP ---
let db = null;
let auth = null;
let currentUser = null;
let currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: '' };
let isMockMode = false;
let tarifario = [];
let cartItems = [];
let selectedPaymentMethod = 'contado'; // 'contado' o 'cuotas'

// Tarifario por defecto (Fallback Offline / Mock)
const defaultTarifario = [
  // Servicios
  { id: 'inst_general', codigo: 'INST-001', nombre: 'Instalación General', categoria: 'Servicios', precio: 45000, unidad: 'servicio' },
  { id: 'inst_referido', codigo: 'INST-002', nombre: 'Instalación Referido', categoria: 'Servicios', precio: 33750, unidad: 'servicio' },
  { id: 'serv_mudanza', codigo: 'SRV-003', nombre: 'Mudanza', categoria: 'Servicios', precio: 10000, unidad: 'servicio' },
  { id: 'serv_reconexion', codigo: 'SRV-004', nombre: 'Reconexión', categoria: 'Servicios', precio: 10000, unidad: 'servicio' },
  { id: 'serv_tecnico', codigo: 'SRV-005', nombre: 'Servicio Técnico', categoria: 'Servicios', precio: 8000, unidad: 'servicio' },
  // Materiales
  { id: 'mat_router', codigo: 'MAT-001', nombre: 'Compra de Router', categoria: 'Materiales', precio: 45000, unidad: 'unidad', cuotas: [{ cantidad: 2, monto: 22500 }] },
  { id: 'mat_tvbox', codigo: 'MAT-002', nombre: 'Compra de TvBox', categoria: 'Materiales', precio: 50000, unidad: 'unidad', cuotas: [{ cantidad: 3, monto: 22000 }] },
  { id: 'mat_transformador', codigo: 'MAT-003', nombre: 'Transformador de Router o TvBox', categoria: 'Materiales', precio: 10000, unidad: 'unidad' },
  { id: 'mat_control', codigo: 'MAT-004', nombre: 'Control Remoto de TvBox', categoria: 'Materiales', precio: 10000, unidad: 'unidad' },
  { id: 'mat_cable', codigo: 'MAT-005', nombre: 'Metro de Cable', categoria: 'Materiales', precio: 500, unidad: 'metro' }
];

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initNetworkMonitoring();
  initFirebaseOrMock();
  initRouter();
  setupEventListeners();
});

// --- 1. CAPA DE CONEXIÓN Y RED (Fase L - Link) ---

function initNetworkMonitoring() {
  const banner = document.getElementById('network-status');
  const text = document.getElementById('network-text');

  const updateStatus = () => {
    if (navigator.onLine) {
      banner.classList.remove('offline');
      banner.classList.add('online');
      text.textContent = 'Conectado (En línea)';
      // Disparar sincronización si volvemos a estar online
      syncOfflineComprobantes();
    } else {
      banner.classList.remove('online');
      banner.classList.add('offline');
      text.textContent = 'Modo Sin Conexión (Offline)';
    }
  };

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus(); // Estado inicial
}

function initFirebaseOrMock() {
  // Comprobar si las credenciales son las por defecto "TU_API_KEY"
  if (!firebaseConfig || firebaseConfig.apiKey === 'TU_API_KEY') {
    enableMockMode('Credenciales de Firebase no configuradas. Usando Modo Demo Local.');
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    // Habilitar persistencia offline en Firestore
    enableIndexedDbPersistence(db).catch((err) => {
      if (err.code == 'failed-precondition') {
        console.warn('La persistencia falló: Múltiples pestañas abiertas.');
      } else if (err.code == 'unimplemented') {
        console.warn('El navegador no soporta persistencia de datos offline.');
      }
    });

    console.log('Firebase inicializado correctamente.');
  } catch (error) {
    console.error('Error al inicializar Firebase:', error);
    enableMockMode('Error al conectar con Firebase. Iniciando Modo Demo.');
  }
}

function enableMockMode(reason) {
  isMockMode = true;
  console.log(`%c[MODO DEMO] ${reason}`, 'color: #f59e0b; font-weight: bold; font-size: 1.1em;');
  
  // Agregar un distintivo en la interfaz para avisar al técnico
  const badge = document.createElement('div');
  badge.id = 'demo-badge';
  badge.innerHTML = '⚠️ MODO DEMO LOCAL';
  badge.style.cssText = 'position: fixed; bottom: 10px; right: 10px; background: #f59e0b; color: #000; padding: 5px 10px; font-size: 11px; font-weight: bold; border-radius: 4px; z-index: 10000; pointer-events: none; opacity: 0.85;';
  document.body.appendChild(badge);
  
  // Intentar cargar tarifas.json primero, fallback a defaults
  fetch('./tarifas.json')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.length > 0) {
        tarifario = data;
        console.log(`[MODO DEMO] Tarifario cargado desde tarifas.json (${data.length} ítems)`);
      } else {
        tarifario = [...defaultTarifario];
      }
      updateTarifarioDropdown();
    })
    .catch(() => {
      tarifario = [...defaultTarifario];
      updateTarifarioDropdown();
    });
}

// --- 2. CAPA DE NAVEGACIÓN Y RUTAS (Fase A - Architect) ---

function initRouter() {
  const handleRoute = () => {
    const hash = window.location.hash || '#/panel';
    hideAllViews();

    if (hash === '#/login') {
      showView('view-login');
      checkLoginState(true); // Redirige al panel si ya está logueado
    } else if (hash === '#/panel') {
      checkLoginState(false, () => {
        showView('view-panel');
        loadTarifario();
        switchTab('service'); // Por defecto iniciar en la pestaña de carga
      });
    } else if (hash.startsWith('#/comprobante/')) {
      const parts = hash.split('/');
      const id = parts[parts.length - 1];
      showView('view-comprobante');
      loadComprobanteView(id);
    } else {
      // Redirección por defecto
      window.location.hash = '#/panel';
    }
  };

  window.addEventListener('hashchange', handleRoute);
  handleRoute(); // Carga de ruta inicial
}

function hideAllViews() {
  document.querySelectorAll('.app-view').forEach(view => view.classList.add('hidden'));
}

function showView(id) {
  const view = document.getElementById(id);
  if (view) view.classList.remove('hidden');
}

function checkLoginState(isOnLoginRoute, onAuthSuccessCallback) {
  if (isMockMode) {
    const session = localStorage.getItem('mock_session');
    if (session) {
      currentUser = JSON.parse(session);
      currentTechData = { nombre: currentUser.nombre, empresa: currentUser.empresa, email: currentUser.email };
      updateTechProfileUI();
      if (isOnLoginRoute) {
        window.location.hash = '#/panel';
      } else if (onAuthSuccessCallback) {
        onAuthSuccessCallback();
      }
    } else {
      if (!isOnLoginRoute) {
        window.location.hash = '#/login';
      }
    }
    return;
  }

  // Firebase Real Auth Listener
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      
      // Intentar recuperar los datos del técnico desde la colección usuarios de Firestore
      try {
        const userDoc = await getDoc(doc(db, 'usuarios', user.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          currentTechData = {
            nombre: data.nombre || 'Técnico de Campo',
            empresa: data.empresa || 'TuRed',
            email: user.email
          };
        } else {
          currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: user.email };
        }
      } catch (e) {
        console.warn('No se pudo cargar datos adicionales del técnico (offline o sin permisos). Usando defaults.');
        currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: user.email };
      }
      
      updateTechProfileUI();
      if (isOnLoginRoute) {
        window.location.hash = '#/panel';
      } else if (onAuthSuccessCallback) {
        onAuthSuccessCallback();
      }
    } else {
      currentUser = null;
      if (!isOnLoginRoute) {
        window.location.hash = '#/login';
      }
    }
  });
}

function updateTechProfileUI() {
  document.getElementById('user-display-name').textContent = currentTechData.nombre;
  document.getElementById('user-display-company').textContent = currentTechData.empresa;
  
  // Rellenar avatares e iniciales
  const initials = currentTechData.nombre.charAt(0).toUpperCase();
  document.querySelectorAll('.avatar').forEach(avatar => avatar.textContent = initials);
}

// --- 3. LÓGICA DE NEGOCIO Y OPERACIÓN (Fase A/S - Architect & Stylize) ---

// Setup de Event Listeners
function setupEventListeners() {
  // Login Form
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', handleLogin);

  // Pestañas del Panel
  const tabBtnService = document.getElementById('tab-btn-service');
  const tabBtnHistory = document.getElementById('tab-btn-history');
  const btnRefreshHistory = document.getElementById('btn-refresh-history');

  if (tabBtnService && tabBtnHistory) {
    tabBtnService.addEventListener('click', () => switchTab('service'));
    tabBtnHistory.addEventListener('click', () => switchTab('history'));
  }
  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', loadHistorialComprobantes);
  }

  // Logout Button
  const btnLogout = document.getElementById('btn-logout');
  btnLogout.addEventListener('click', handleLogout);

  // Controls del Carrito
  const btnQtyMinus = document.getElementById('btn-qty-minus');
  const btnQtyPlus = document.getElementById('btn-qty-plus');
  const inputQuantity = document.getElementById('item-quantity');

  btnQtyMinus.addEventListener('click', () => {
    let val = parseInt(inputQuantity.value) || 1;
    if (val > 1) inputQuantity.value = val - 1;
  });

  btnQtyPlus.addEventListener('click', () => {
    let val = parseInt(inputQuantity.value) || 1;
    inputQuantity.value = val + 1;
  });

  // Evento al cambiar ítem seleccionado
  const itemSelector = document.getElementById('item-selector');
  itemSelector.addEventListener('change', (e) => {
    const selectedId = e.target.value;
    const item = tarifario.find(t => t.id === selectedId);
    const pricePreview = document.getElementById('item-price-preview');
    const paymentContainer = document.getElementById('payment-method-container');
    const btnContado = document.getElementById('btn-pago-contado');
    const btnCuotas = document.getElementById('btn-pago-cuotas');
    const cuotasInfo = document.getElementById('cuotas-info');

    if (item) {
      pricePreview.value = formatCurrency(item.precio);

      // Mostrar selector de pago si el ítem tiene cuotas
      if (item.cuotas && item.cuotas.length > 0) {
        paymentContainer.classList.remove('hidden');
        // Reset a contado
        selectedPaymentMethod = 'contado';
        btnContado.classList.add('active');
        btnCuotas.classList.remove('active');
        cuotasInfo.classList.add('hidden');
      } else {
        paymentContainer.classList.add('hidden');
        selectedPaymentMethod = 'contado';
      }
    } else {
      pricePreview.value = '$0.00';
      paymentContainer.classList.add('hidden');
      selectedPaymentMethod = 'contado';
    }
  });

  // Botones de método de pago
  const btnContado = document.getElementById('btn-pago-contado');
  const btnCuotas = document.getElementById('btn-pago-cuotas');
  const cuotasInfo = document.getElementById('cuotas-info');

  btnContado.addEventListener('click', () => {
    selectedPaymentMethod = 'contado';
    btnContado.classList.add('active');
    btnCuotas.classList.remove('active');
    cuotasInfo.classList.add('hidden');
  });

  btnCuotas.addEventListener('click', () => {
    selectedPaymentMethod = 'cuotas';
    btnCuotas.classList.add('active');
    btnContado.classList.remove('active');
    // Mostrar info de cuotas del ítem seleccionado
    const selectedId = document.getElementById('item-selector').value;
    const item = tarifario.find(t => t.id === selectedId);
    if (item && item.cuotas && item.cuotas.length > 0) {
      const c = item.cuotas[0]; // Tomar la primera opción de cuotas
      cuotasInfo.textContent = `${c.cantidad} cuotas de ${formatCurrency(c.monto)} = ${formatCurrency(c.cantidad * c.monto)}`;
      cuotasInfo.classList.remove('hidden');
    }
  });

  // Botón Agregar Ítem
  const btnAddItem = document.getElementById('btn-add-item');
  btnAddItem.addEventListener('click', addItemToCart);

  // Botón Generar Comprobante
  const btnGenerateReceipt = document.getElementById('btn-generate-receipt');
  btnGenerateReceipt.addEventListener('click', generateComprobante);

  // Botón Volver al Panel
  const btnReceiptBack = document.getElementById('btn-receipt-back');
  btnReceiptBack.addEventListener('click', () => {
    window.location.hash = '#/panel';
  });

  // Botón Imprimir
  const btnReceiptPrint = document.getElementById('btn-receipt-print');
  btnReceiptPrint.addEventListener('click', () => {
    window.print();
  });
  
  // Validaciones del formulario de cliente para habilitar botón
  const clientName = document.getElementById('client-name');
  const clientAddress = document.getElementById('client-address');
  
  const validateForm = () => {
    btnGenerateReceipt.disabled = !(clientName.value.trim() && clientAddress.value.trim() && cartItems.length > 0);
  };
  
  clientName.addEventListener('input', validateForm);
  clientAddress.addEventListener('input', validateForm);
}

// Handler de Inicio de Sesión
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const spinner = document.getElementById('login-spinner');
  const btnText = document.querySelector('#btn-login span');
  const errorText = document.getElementById('login-error');

  errorText.classList.add('hidden');
  spinner.classList.remove('hidden');
  btnText.classList.add('hidden');

  if (isMockMode) {
    // Simular retraso de red
    setTimeout(() => {
      spinner.classList.add('hidden');
      btnText.classList.remove('hidden');

      if (email && password.length >= 4) {
        // Login mock exitoso
        const mockUser = {
          uid: 'mock_uid_123',
          email: email,
          nombre: email.split('@')[0].toUpperCase(),
          empresa: 'TuRed MOCK'
        };
        localStorage.setItem('mock_session', JSON.stringify(mockUser));
        currentUser = mockUser;
        currentTechData = { nombre: mockUser.nombre, empresa: mockUser.empresa, email: mockUser.email };
        updateTechProfileUI();
        window.location.hash = '#/panel';
      } else {
        errorText.textContent = 'Usuario o contraseña incorrectos (Mínimo 4 caracteres).';
        errorText.classList.remove('hidden');
      }
    }, 1000);
    return;
  }

  // Firebase Auth Real
  try {
    await signInWithEmailAndPassword(auth, email, password);
    // El listener onAuthStateChanged redirigirá automáticamente
  } catch (error) {
    console.error('Login error:', error);
    spinner.classList.add('hidden');
    btnText.classList.remove('hidden');
    
    let errMsg = 'Error al iniciar sesión. Verifique sus datos.';
    if (error.code === 'auth/invalid-credential') {
      errMsg = 'Credenciales incorrectas.';
    } else if (error.code === 'auth/network-request-failed') {
      errMsg = 'Error de conexión. Se requiere internet para el primer login.';
    }
    
    errorText.textContent = errMsg;
    errorText.classList.remove('hidden');
  }
}

// Handler de Cierre de Sesión
async function handleLogout() {
  if (isMockMode) {
    localStorage.removeItem('mock_session');
    currentUser = null;
    window.location.hash = '#/login';
    return;
  }

  try {
    await signOut(auth);
    window.location.hash = '#/login';
  } catch (error) {
    console.error('Error al cerrar sesión:', error);
  }
}

// Carga de Tarifario
async function loadTarifario() {
  if (isMockMode) {
    // Ya está cargado en enableMockMode()
    return;
  }

  // 1. Intentar cargar desde tarifas.json (archivo editable local)
  try {
    const response = await fetch('./tarifas.json');
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        tarifario = data;
        console.log(`Tarifario cargado desde tarifas.json (${data.length} ítems)`);
        updateTarifarioDropdown();
        return;
      }
    }
  } catch (e) {
    console.warn('No se pudo cargar tarifas.json:', e);
  }

  // 2. Intentar cargar desde Firestore (si Firebase está configurado)
  if (db) {
    try {
      const querySnapshot = await getDocs(collection(db, 'tarifas'));
      const tempTarifas = [];
      querySnapshot.forEach((doc) => {
        tempTarifas.push({ id: doc.id, ...doc.data() });
      });

      if (tempTarifas.length > 0) {
        tarifario = tempTarifas;
        console.log(`Tarifario cargado desde Firestore (${tempTarifas.length} ítems)`);
        updateTarifarioDropdown();
        return;
      }
    } catch (error) {
      console.warn('Error al cargar tarifario de Firestore (offline).', error);
    }
  }

  // 3. Fallback: tarifas hardcoded
  console.log('Usando tarifas por defecto (hardcoded).');
  tarifario = [...defaultTarifario];
  updateTarifarioDropdown();
}

// Actualizar dropdown de tarifas
function updateTarifarioDropdown() {
  const selector = document.getElementById('item-selector');
  selector.innerHTML = '<option value="">-- Selecciona una opción --</option>';

  // Agrupar por categoría
  const categorias = [...new Set(tarifario.map(t => t.categoria))];

  categorias.forEach(cat => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = cat;

    const items = tarifario.filter(t => t.categoria === cat);
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      let label = `${item.codigo} - ${item.nombre} (${formatCurrency(item.precio)})`;
      if (item.cuotas && item.cuotas.length > 0) {
        const c = item.cuotas[0];
        label += ` - ${c.cantidad} cuotas de ${formatCurrency(c.monto)}`;
      }
      option.textContent = label;
      optgroup.appendChild(option);
    });

    selector.appendChild(optgroup);
  });
}

// Agregar Ítem al Presupuesto
function addItemToCart() {
  const selector = document.getElementById('item-selector');
  const selectedId = selector.value;
  const quantityInput = document.getElementById('item-quantity');
  const quantity = parseInt(quantityInput.value) || 1;

  if (!selectedId) {
    alert('Por favor selecciona un servicio o insumo de la lista.');
    return;
  }

  const item = tarifario.find(t => t.id === selectedId);
  if (!item) return;

  // Verificar si ya existe en el carrito
  const existingItemIndex = cartItems.findIndex(i => i.tarifa_id === item.id);

  if (existingItemIndex > -1) {
    // Sumar cantidad
    cartItems[existingItemIndex].cantidad += quantity;
    cartItems[existingItemIndex].subtotal = cartItems[existingItemIndex].cantidad * cartItems[existingItemIndex].precio_unitario;
  } else {
    // Crear nuevo ítem
    const cartItem = {
      item_index: cartItems.length,
      tarifa_id: item.id,
      codigo: item.codigo,
      nombre: item.nombre,
      cantidad: quantity,
      precio_unitario: item.precio,
      subtotal: quantity * item.precio,
      metodo_pago: selectedPaymentMethod
    };

    // Si eligió cuotas, guardar info de cuotas
    if (selectedPaymentMethod === 'cuotas' && item.cuotas && item.cuotas.length > 0) {
      cartItem.cuotas_info = item.cuotas[0];
    }

    cartItems.push(cartItem);
  }

  // Reset del selector
  selector.value = '';
  quantityInput.value = 1;
  document.getElementById('item-price-preview').value = '$0.00';
  document.getElementById('payment-method-container').classList.add('hidden');
  selectedPaymentMethod = 'contado';

  updateCartTable();
}

// Actualizar Tabla del Carrito y Totales
function updateCartTable() {
  const cartBody = document.getElementById('cart-body');
  cartBody.innerHTML = '';

  if (cartItems.length === 0) {
    cartBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5" class="text-center">No hay ítems agregados a este presupuesto.</td>
      </tr>
    `;
    updateTotalsUI(0);
    return;
  }

  cartItems.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    // Badge de método de pago
    let paymentBadge = '';
    if (item.metodo_pago === 'cuotas' && item.cuotas_info) {
      paymentBadge = `<span class="payment-method-badge badge-cuotas">${item.cuotas_info.cantidad} cuotas</span>`;
    } else {
      paymentBadge = `<span class="payment-method-badge badge-contado">Contado</span>`;
    }

    tr.innerHTML = `
      <td><strong>${item.codigo}</strong><br>${item.nombre}${paymentBadge}</td>
      <td class="text-center">${item.cantidad}</td>
      <td class="text-right">${formatCurrency(item.precio_unitario)}</td>
      <td class="text-right">${formatCurrency(item.subtotal)}</td>
      <td class="text-center">
        <button type="button" class="btn-delete" data-index="${index}" title="Eliminar ítem">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </td>
    `;
    cartBody.appendChild(tr);
  });

  // Asignar eventos de borrado
  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-index'));
      cartItems.splice(idx, 1);
      // Reindexar
      cartItems.forEach((item, i) => item.item_index = i);
      updateCartTable();
    });
  });

  // Calcular totales
  const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
  updateTotalsUI(subtotal);
}

function updateTotalsUI(subtotal) {
  const total = subtotal;

  document.getElementById('summary-subtotal').textContent = formatCurrency(subtotal);
  document.getElementById('summary-total').textContent = formatCurrency(total);

  // Validar campos del formulario
  const clientName = document.getElementById('client-name').value.trim();
  const clientAddress = document.getElementById('client-address').value.trim();
  const btnGenerateReceipt = document.getElementById('btn-generate-receipt');

  btnGenerateReceipt.disabled = !(clientName && clientAddress && cartItems.length > 0);
}

// Generación y almacenamiento del comprobante (Offline-first)
async function generateComprobante() {
  const clientId = document.getElementById('client-id').value.trim();
  const clientName = document.getElementById('client-name').value.trim();
  const clientAddress = document.getElementById('client-address').value.trim();
  const clientPhone = document.getElementById('client-phone').value.trim();
  const clientEmail = document.getElementById('client-email').value.trim();
  const notes = document.getElementById('receipt-notes').value.trim();

  const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
  const total = subtotal;

  // Generar ID único local
  const uuid = 'comp_' + Math.random().toString(36).substr(2, 9) + Date.now().toString().substr(-4);

  const comprobante = {
    comprobante_id: uuid,
    tecnico_uid: currentUser ? currentUser.uid : 'mock_tecnico',
    tecnico_nombre: currentTechData.nombre,
    tecnico_empresa: currentTechData.empresa,
    fecha_creacion: new Date().toISOString(),
    fecha_servicio: new Date().toISOString().split('T')[0],
    cliente: {
      numero_cliente: clientId || '',
      nombre: clientName,
      direccion: clientAddress,
      telefono: clientPhone || '',
      email: clientEmail || ''
    },
    items: [...cartItems],
    subtotal: subtotal,
    total: total,
    observaciones: notes,
    estado: navigator.onLine ? 'sincronizado' : 'pendiente_sincronizacion',
    fecha_sincronizacion: navigator.onLine ? new Date().toISOString() : null,
    intentos_sincronizacion: 0,
    metadata: {
      dispositivo: navigator.userAgent,
      plataforma: getPlatform(),
      version_app: '1.0.0'
    }
  };

  // Guardar en la base de datos
  if (isMockMode) {
    // Modo Mock: Guardar en localStorage
    const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    savedReceipts.push(comprobante);
    localStorage.setItem('mock_comprobantes', JSON.stringify(savedReceipts));
    console.log('Comprobante mock guardado localmente:', comprobante);
  } else {
    // Firestore SDK persistencia offline (se guarda localmente en IndexedDB de forma automática)
    try {
      // Usar comprobante_id como nombre del documento
      await setDoc(doc(db, 'comprobantes', uuid), comprobante);
      console.log('Comprobante enviado al SDK de Firestore:', uuid);
    } catch (e) {
      console.error('Error al guardar comprobante en Firestore:', e);
      // El SDK intentará subirlo de nuevo si la persistencia falló a nivel de app
    }
  }

  // Guardar comprobante temporal en local para visualización directa
  localStorage.setItem(`receipt_cache_${uuid}`, JSON.stringify(comprobante));

  // Limpiar Carrito y Formulario del Panel
  resetPanelForm();

  // Redirigir a la vista de comprobante
  window.location.hash = `#/comprobante/${uuid}`;
}

function resetPanelForm() {
  cartItems = [];
  document.getElementById('client-id').value = '';
  document.getElementById('client-name').value = '';
  document.getElementById('client-address').value = '';
  document.getElementById('client-phone').value = '';
  document.getElementById('client-email').value = '';
  document.getElementById('receipt-notes').value = '';
  updateCartTable();
}

// Carga visual del comprobante generado (A4 o Público)
async function loadComprobanteView(id) {
  let comprobante = null;

  // Intentar cargar desde el localStorage (cache rápida del técnico)
  const cached = localStorage.getItem(`receipt_cache_${id}`);
  if (cached) {
    comprobante = JSON.parse(cached);
  } else {
    // Si no está en la cache (ej: cliente escaneando el QR), consultar Firestore
    if (isMockMode) {
      const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
      comprobante = savedReceipts.find(r => r.comprobante_id === id);
    } else {
      try {
        const docRef = await getDoc(doc(db, 'comprobantes', id));
        if (docRef.exists()) {
          comprobante = docRef.data();
        }
      } catch (e) {
        console.error('Error cargando comprobante público:', e);
      }
    }
  }

  const receiptPaper = document.getElementById('receipt-paper');
  const actionBar = document.querySelector('.action-bar-container');

  if (!comprobante) {
    // Mostrar error si no existe
    receiptPaper.innerHTML = `
      <div class="text-center" style="padding: 4rem;">
        <h2 style="color: var(--accent-danger);">Comprobante No Encontrado</h2>
        <p style="margin-top: 1rem; color: #4b5563;">El código de comprobante es inválido o el documento aún no se ha sincronizado con la nube.</p>
        <button onclick="window.location.hash='#/panel'" class="btn btn-secondary mt-3">Volver al Panel</button>
      </div>
    `;
    actionBar.classList.add('hidden');
    return;
  }

  // Controlar visibilidad de botones del técnico
  // Si no hay técnico logueado o es un cliente escaneando el QR, ocultamos los botones de acción del técnico
  const sessionActive = isMockMode ? !!localStorage.getItem('mock_session') : !!auth.currentUser;
  
  if (sessionActive) {
    actionBar.classList.remove('hidden');
  } else {
    actionBar.classList.add('hidden');
  }

  // Rellenar datos en la factura A4
  document.getElementById('r-id').textContent = comprobante.comprobante_id.toUpperCase();
  document.getElementById('r-date').textContent = formatDate(comprobante.fecha_creacion);
  
  // Badge de Sync
  const syncBadge = document.getElementById('r-sync-status');
  if (comprobante.estado === 'sincronizado') {
    syncBadge.textContent = 'Sincronizado con la Nube';
    syncBadge.className = 'receipt-sync-badge sync-status-online';
  } else {
    syncBadge.textContent = 'Pendiente de Sincronización';
    syncBadge.className = 'receipt-sync-badge sync-status-offline';
  }

  // Emisor
  document.getElementById('r-tech-name').textContent = comprobante.tecnico_nombre;
  document.getElementById('r-tech-company').textContent = comprobante.tecnico_empresa;

  // Cliente
  const clientIdContainer = document.getElementById('r-client-id-container');
  if (comprobante.cliente.numero_cliente) {
    document.getElementById('r-client-id').textContent = comprobante.cliente.numero_cliente;
    clientIdContainer.style.display = 'block';
  } else {
    clientIdContainer.style.display = 'none';
  }

  document.getElementById('r-client-name').textContent = comprobante.cliente.nombre;
  document.getElementById('r-client-address').textContent = comprobante.cliente.direccion;
  
  const phoneContainer = document.getElementById('r-client-phone-container');
  if (comprobante.cliente.telefono) {
    document.getElementById('r-client-phone').textContent = comprobante.cliente.telefono;
    phoneContainer.style.display = 'block';
  } else {
    phoneContainer.style.display = 'none';
  }

  const emailContainer = document.getElementById('r-client-email-container');
  if (comprobante.cliente.email) {
    document.getElementById('r-client-email').textContent = comprobante.cliente.email;
    emailContainer.style.display = 'block';
  } else {
    emailContainer.style.display = 'none';
  }

  // Notas
  const rNotes = document.getElementById('r-notes');
  if (comprobante.observaciones) {
    rNotes.textContent = comprobante.observaciones;
    rNotes.style.display = 'block';
  } else {
    rNotes.textContent = 'Sin observaciones adicionales.';
  }

  // Rellenar Tabla de Ítems
  const rItemsBody = document.getElementById('r-items-body');
  rItemsBody.innerHTML = '';
  comprobante.items.forEach(item => {
    const tr = document.createElement('tr');
    
    // Info de método de pago
    let paymentInfo = '';
    if (item.metodo_pago === 'cuotas' && item.cuotas_info) {
      paymentInfo = `<br><small style="color: #d97706; font-weight: 500;">${item.cuotas_info.cantidad} cuotas de ${formatCurrency(item.cuotas_info.monto)}</small>`;
    }

    tr.innerHTML = `
      <td>${item.codigo}</td>
      <td><strong>${item.nombre}</strong>${paymentInfo}</td>
      <td class="text-center">${item.cantidad}</td>
      <td class="text-right">${formatCurrency(item.precio_unitario)}</td>
      <td class="text-right">${formatCurrency(item.subtotal)}</td>
    `;
    rItemsBody.appendChild(tr);
  });

  // Totales
  document.getElementById('r-subtotal').textContent = formatCurrency(comprobante.subtotal);
  document.getElementById('r-total').textContent = formatCurrency(comprobante.total);

  // Generar QR Code
  // URL del QR apunta a la ruta pública del comprobante en la PWA
  const urlPublica = `${window.location.origin}${window.location.pathname}#/comprobante/${comprobante.comprobante_id}`;
  generateQRCode(urlPublica);
}

// Función Generadora de Código QR usando qrcode-generator
function generateQRCode(url) {
  const qrContainer = document.getElementById('qrcode-canvas');
  qrContainer.innerHTML = ''; // Limpiar previo

  try {
    // Parámetros: Tipo de QR (1-40, 4 es ideal para urls de tamaño medio), Nivel corrección error ('L','M','Q','H')
    const typeNumber = 4;
    const errorCorrectionLevel = 'L';
    const qr = qrcode(typeNumber, errorCorrectionLevel);
    qr.addData(url);
    qr.make();
    
    // Crear el SVG o Imagen
    const cellSize = 3; // Tamaño del píxel en el QR
    const margin = 4;
    const qrImageHtml = qr.createImgTag(cellSize, margin);
    
    qrContainer.innerHTML = qrImageHtml;
  } catch (error) {
    console.error('Error al generar código QR:', error);
    qrContainer.innerHTML = '<span style="font-size: 10px; color: var(--accent-danger)">Error QR</span>';
  }
}

// Sincronización manual en background para registros guardados en Mock Mode u offline
async function syncOfflineComprobantes() {
  if (isMockMode) {
    // Sincronizar comprobantes mock pendientes si detectamos red y hay datos reales
    const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    const pending = savedReceipts.filter(r => r.estado === 'pendiente_sincronizacion');
    
    if (pending.length === 0) return;

    console.log(`[Sync] Sincronizando ${pending.length} comprobantes locales MOCK...`);
    
    pending.forEach(r => {
      r.estado = 'sincronizado';
      r.fecha_sincronizacion = new Date().toISOString();
      
      // Actualizar cache local
      localStorage.setItem(`receipt_cache_${r.comprobante_id}`, JSON.stringify(r));
    });

    localStorage.setItem('mock_comprobantes', JSON.stringify(savedReceipts));
    console.log('[Sync] Sincronización MOCK completada.');
    
    // Si estamos en la vista de comprobante actual, actualizar UI
    const hash = window.location.hash;
    if (hash.startsWith('#/comprobante/')) {
      const parts = hash.split('/');
      const id = parts[parts.length - 1];
      loadComprobanteView(id);
    }
  } else {
    // Con Firebase real, Firestore maneja la cola de sincronización de manera transparente.
    // El SDK de Firestore tiene su propio hilo de fondo que detecta la red e impacta los cambios.
    console.log('[Sync] Firebase Firestore se encuentra en línea y gestiona la cola.');
  }
}

// Alternar entre las pestañas "Nuevo Servicio" e "Historial"
function switchTab(tabName) {
  const tabBtnService = document.getElementById('tab-btn-service');
  const tabBtnHistory = document.getElementById('tab-btn-history');
  const containerService = document.getElementById('panel-service-container');
  const containerHistory = document.getElementById('panel-history-container');

  if (!tabBtnService || !tabBtnHistory || !containerService || !containerHistory) return;

  if (tabName === 'service') {
    tabBtnService.classList.add('active');
    tabBtnHistory.classList.remove('active');
    containerService.classList.remove('hidden');
    containerHistory.classList.add('hidden');
  } else if (tabName === 'history') {
    tabBtnHistory.classList.add('active');
    tabBtnService.classList.remove('active');
    containerHistory.classList.remove('hidden');
    containerService.classList.add('hidden');
    
    // Cargar historial al abrir la pestaña
    loadHistorialComprobantes();
  }
}

// Cargar y renderizar el historial de comprobantes
async function loadHistorialComprobantes() {
  const historyBody = document.getElementById('history-body');
  if (!historyBody) return;

  historyBody.innerHTML = `
    <tr>
      <td colspan="6" class="text-center">
        <div style="display: flex; justify-content: center; align-items: center; padding: 1.5rem; gap: 0.5rem; color: var(--text-secondary)">
          Cargando comprobantes... <div class="spinner" style="border-width: 2px; width: 16px; height: 16px;"></div>
        </div>
      </td>
    </tr>
  `;

  let comprobantes = [];

  if (isMockMode) {
    // Modo Demo: Cargar de localStorage
    const saved = localStorage.getItem('mock_comprobantes');
    if (saved) {
      comprobantes = JSON.parse(saved);
    }
  } else {
    // Firebase Real: Consultar Firestore
    try {
      if (!currentUser) return;
      
      // Consultamos Firestore
      const q = query(collection(db, 'comprobantes'), where('tecnico_uid', '==', currentUser.uid));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        comprobantes.push(doc.data());
      });
    } catch (e) {
      console.error('Error al cargar historial desde Firestore:', e);
      
      // Fallback a los cacheados localmente en localStorage
      console.log('Intentando cargar desde la caché local...');
      const keys = Object.keys(localStorage);
      keys.forEach(key => {
        if (key.startsWith('receipt_cache_')) {
          try {
            comprobantes.push(JSON.parse(localStorage.getItem(key)));
          } catch(err) {}
        }
      });
    }
  }

  // Ordenar por fecha descendente
  comprobantes.sort((a, b) => new Date(b.fecha_creacion) - new Date(a.fecha_creacion));

  // Renderizar
  historyBody.innerHTML = '';

  if (comprobantes.length === 0) {
    historyBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6" class="text-center">No se han emitido comprobantes en este dispositivo aún.</td>
      </tr>
    `;
    return;
  }

  comprobantes.forEach(c => {
    const tr = document.createElement('tr');
    
    // Configurar badges de sincronización
    let badgeHtml = '';
    if (c.estado === 'sincronizado') {
      badgeHtml = `<span class="badge-sync badge-sync-online"><span class="badge-dot"></span>Sincronizado</span>`;
    } else {
      badgeHtml = `<span class="badge-sync badge-sync-offline"><span class="badge-dot"></span>Pendiente</span>`;
    }

    tr.innerHTML = `
      <td><strong>${c.comprobante_id.toUpperCase()}</strong></td>
      <td>${c.cliente.nombre}<br><small style="color: var(--text-secondary)">${c.cliente.direccion}</small></td>
      <td>${formatDate(c.fecha_creacion)}</td>
      <td class="text-right" style="font-weight: 600; color: var(--accent-secondary)">${formatCurrency(c.total)}</td>
      <td class="text-center">${badgeHtml}</td>
      <td class="text-center">
        <div class="history-actions">
          <a href="#/comprobante/${c.comprobante_id}" class="btn-view-receipt">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            Ver
          </a>
          <button class="btn-delete-receipt" data-id="${c.comprobante_id}" title="Eliminar comprobante">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      </td>
    `;
    
    historyBody.appendChild(tr);
  });

  // Event listeners para eliminar comprobantes
  document.querySelectorAll('.btn-delete-receipt').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      if (confirm('¿Eliminar este comprobante? Esta acción no se puede deshacer.')) {
        await deleteComprobante(id);
      }
    });
  });
}

// Eliminar comprobante
async function deleteComprobante(id) {
  if (isMockMode) {
    // Eliminar de localStorage
    const saved = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    const filtered = saved.filter(r => r.comprobante_id !== id);
    localStorage.setItem('mock_comprobantes', JSON.stringify(filtered));
    localStorage.removeItem(`receipt_cache_${id}`);
    console.log('[Mock] Comprobante eliminado:', id);
  } else {
    // Eliminar de Firestore
    try {
      await deleteDoc(doc(db, 'comprobantes', id));
      localStorage.removeItem(`receipt_cache_${id}`);
      console.log('Comprobante eliminado de Firestore:', id);
    } catch (e) {
      console.error('Error al eliminar comprobante:', e);
      alert('Error al eliminar. Intenta de nuevo.');
      return;
    }
  }
  
  // Recargar historial
  loadHistorialComprobantes();
}

// --- UTILERÍAS ---

function formatCurrency(amount) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS'
  }).format(amount);
}

function formatDate(isoString) {
  if (!isoString) return '--/--/----';
  const date = new Date(isoString);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function getPlatform() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  if (/android/i.test(userAgent)) return 'android';
  if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) return 'ios';
  return 'web';
}
