export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Array<T>;
}

export interface BaseModel {
  [key: string]: any;

  id: string;
}

export interface RecordModel extends BaseModel {
  collectionId: string;
  collectionName: string;
  expand?: { [key: string]: any };
}
