import type { ImgHTMLAttributes, ReactNode } from "react";
import { flattenConnection, type Connection } from "../graphql/graphql";
import { useDynamiteContext } from "./context";

export const PAGINATION_CURSOR_PARAM = "cursor";
export const PAGINATION_DIRECTION_PARAM = "direction";

/**
 * Returns the connection variables of the current page from the URL cursor params
 * (`?cursor=...&direction=next|previous`), for the loaders of the paginated pages.
 */
export function getPaginationVariables(
  url: string | URL,
  options: { pageBy?: number } = {},
): { first: number; after: string | null } | { last: number; before: string | null } {
  const pageBy = options.pageBy ?? 20;
  const params = new URL(url, "http://localhost").searchParams;
  const cursor = params.get(PAGINATION_CURSOR_PARAM);
  const direction = params.get(PAGINATION_DIRECTION_PARAM);

  if (cursor && direction === "previous") {
    return { last: pageBy, before: cursor };
  }

  return { first: pageBy, after: cursor || null };
}

/**
 * Returns the URL of the next/previous page of a connection (the other query params are kept).
 */
export function getPaginationURL(
  url: string,
  cursor: string,
  direction: "next" | "previous",
): string {
  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.set(PAGINATION_CURSOR_PARAM, cursor);
  parsed.searchParams.set(PAGINATION_DIRECTION_PARAM, direction);

  return parsed.pathname + parsed.search + parsed.hash;
}

export interface PaginationRenderProps<T> {
  nodes: Array<T>;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageUrl: string | null;
  previousPageUrl: string | null;
  NextLink: (props: { children?: ReactNode; className?: string }) => ReactNode;
  PreviousLink: (props: { children?: ReactNode; className?: string }) => ReactNode;
}

export interface PaginationProps<T> {
  /** The Relay connection of the current page (with `pageInfo`). */
  connection: Connection<T> | null | undefined;

  /**
   * The current page URL (path + query; required for SSR, default to the browser location).
   */
  url?: string;

  children: (props: PaginationRenderProps<T>) => ReactNode;
}

/**
 * Renders a page of a Relay connection with URL-cursor links to the next and previous pages
 * (like the Hydrogen `Pagination`; the loader reads the page with {@link getPaginationVariables}).
 * The links are plain anchors, so it works without JavaScript and with any router.
 */
export function Pagination<T>({ connection, url, children }: PaginationProps<T>) {
  const current =
    url ??
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  const pageInfo = connection?.pageInfo || {};

  const nextPageUrl =
    pageInfo.hasNextPage && pageInfo.endCursor
      ? getPaginationURL(current, pageInfo.endCursor, "next")
      : null;
  const previousPageUrl =
    pageInfo.hasPreviousPage && pageInfo.startCursor
      ? getPaginationURL(current, pageInfo.startCursor, "previous")
      : null;

  return (
    <>
      {children({
        nodes: flattenConnection(connection),
        hasNextPage: !!pageInfo.hasNextPage,
        hasPreviousPage: !!pageInfo.hasPreviousPage,
        nextPageUrl,
        previousPageUrl,
        NextLink: ({ children: label = "Next", className }) =>
          nextPageUrl ? (
            <a href={nextPageUrl} rel="next" className={className}>
              {label}
            </a>
          ) : null,
        PreviousLink: ({ children: label = "Previous", className }) =>
          previousPageUrl ? (
            <a href={previousPageUrl} rel="prev" className={className}>
              {label}
            </a>
          ) : null,
      })}
    </>
  );
}

export interface FileImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** The record that owns the file (`id` + `collectionId` or `collectionName`). */
  record: { [key: string]: any };
  /** The file name (a value of the record file field). */
  filename: string;
  /** Optional thumb size (e.g. "100x100"; the field must allow it). */
  thumb?: string;
  /** Optional file token of a protected file. */
  token?: string;
}

/**
 * Renders a record file image (the URL is built with the provider storefront client).
 */
export function FileImage({ record, filename, thumb, token, alt = "", ...rest }: FileImageProps) {
  const storefront = useDynamiteContext().storefront;

  const query: { [key: string]: string } = {};
  if (thumb) {
    query.thumb = thumb;
  }
  if (token) {
    query.token = token;
  }

  const src = storefront.getFileURL(record, filename, query);
  if (!src) {
    return null;
  }

  return <img src={src} alt={alt} {...rest} />;
}
