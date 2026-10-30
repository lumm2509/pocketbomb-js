"use client";

import type { AuthRecord } from "@pocketbomb/primer";
import { DynamiteProvider } from "@pocketbomb/dynamite/react";

const customer = { routes: { login: "/account/login", logout: "/account/logout" } };

export function Providers(props: {
  url: string;
  publicKey: string;
  initialCustomer: AuthRecord;
  children: React.ReactNode;
}) {
  return (
    <DynamiteProvider
      url={props.url}
      publicKey={props.publicKey}
      customer={customer}
      initialCustomer={props.initialCustomer}
    >
      {props.children}
    </DynamiteProvider>
  );
}
