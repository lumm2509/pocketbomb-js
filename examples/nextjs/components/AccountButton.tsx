"use client";

import { useCustomer } from "pocketbomb-dynamite/react";

export function AccountButton() {
  const { customer, isLoggedIn, login } = useCustomer();

  return isLoggedIn ? (
    <a href="/account" className="account-link">
      {customer?.email}
    </a>
  ) : (
    <button type="button" className="login" onClick={() => void login()}>
      Sign in
    </button>
  );
}
