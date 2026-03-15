// public/script.js

// Get auth token
function getToken() {
    return localStorage.getItem('token');
}

// Get auth headers
function getAuthHeaders() {
    const token = getToken();
    return {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : ''
    };
}

// Check authentication
function checkAuth() {
    const token = getToken();
    if (!token) {
        window.location.href = '/login';
        return false;
    }
    return true;
}

// Logout function
document.addEventListener('DOMContentLoaded', function() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            
            try {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                
                localStorage.removeItem('token');
                window.location.href = '/';
            } catch (error) {
                console.error('Logout error:', error);
            }
        });
    }
});

// Format currency
function formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency
    }).format(amount);
}

// Format date
function formatDate(dateString) {
    return new Date(dateString).toLocaleString();
}

// Show alert
function showAlert(message, type = 'success', containerId = 'alert-container') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type}`;
    alertDiv.textContent = message;
    
    const container = document.getElementById(containerId);
    if (container) {
        container.appendChild(alertDiv);
        setTimeout(() => alertDiv.remove(), 5000);
    }
}
