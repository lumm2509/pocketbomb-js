import { useCustomer } from "@pocketbomb/dynamite/react";
import { Link } from "react-router";

// the customer from the server session (DynamiteProvider initialCustomer); the actions
// navigate to the account routes
export function AccountMenu() {
  const { customer, isLoggedIn, login, signup } = useCustomer();

  if (isLoggedIn) {
    return (
      <Link to="/account" className="account-link">
        {customer?.email}
      </Link>
    );
  }

  return (
    <>
      <button type="button" className="login" onClick={() => void login()}>
        Sign in
      </button>{" "}
      <button type="button" className="signup" onClick={() => void signup()}>
        Sign up
      </button>
    </>
  );
}
