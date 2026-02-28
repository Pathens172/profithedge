document.addEventListener("DOMContentLoaded", () => {
  const signInBtn = document.getElementById("sign-in-btn");
  const getAccessBtn = document.getElementById("get-access-btn");
  const loginModal = document.getElementById("login-modal");
  const closeLogin = document.getElementById("close-login");
  const loginForm = document.getElementById("login-form");
  const accessForm = document.getElementById("access-form");

  const markLoggedIn = () => {
    localStorage.setItem("ph_logged_in", "1");
    getAccessBtn.disabled = false;
  };

  const isLoggedIn = () => localStorage.getItem("ph_logged_in") === "1";

  if (isLoggedIn()) {
    getAccessBtn.disabled = false;
  }

  signInBtn.addEventListener("click", () => {
    loginModal.hidden = false;
  });

  closeLogin.addEventListener("click", () => {
    loginModal.hidden = true;
  });

  loginModal.addEventListener("click", (e) => {
    if (e.target === loginModal) {
      loginModal.hidden = true;
    }
  });

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    // Here you would normally send credentials to your backend API.
    // For now we just treat any email/password as a valid login.
    markLoggedIn();
    loginModal.hidden = true;
    // Go straight to the dashboard after sign in so the user
    // does not have to click again.
    window.location.href = "dashboard.html";
  });

  accessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!isLoggedIn()) {
      alert("Please sign in before getting access.");
      return;
    }
    // Replace this with your real access / payment / dashboard URL.
    window.location.href = "dashboard.html";
  });
});

