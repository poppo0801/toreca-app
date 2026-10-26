export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      account_eligibilities: {
        Row: {
          archived_at: string | null
          chain_id: string
          created_at: string
          household_id: string
          id: string
          memo: string
          requirement_id: string
          service_account_id: string
          state: string
          updated_at: string
          updated_by_profile_id: string | null
          valid_from: string | null
          valid_until: string | null
          verified_on: string | null
        }
        Insert: {
          archived_at?: string | null
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          memo?: string
          requirement_id: string
          service_account_id: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string | null
          valid_until?: string | null
          verified_on?: string | null
        }
        Update: {
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          memo?: string
          requirement_id?: string
          service_account_id?: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string | null
          valid_until?: string | null
          verified_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_eligibilities_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_eligibilities_requirement_id_chain_id_household_id_fkey"
            columns: ["requirement_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chain_requirements"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "account_eligibilities_service_account_id_chain_id_househol_fkey"
            columns: ["service_account_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "account_eligibilities_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      address_groups: {
        Row: {
          archived_at: string | null
          created_at: string
          household_id: string
          id: string
          label: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          household_id: string
          id?: string
          label: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          household_id?: string
          id?: string
          label?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "address_groups_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_groups_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      application_rules: {
        Row: {
          basis: string
          campaign_id: string | null
          chain_id: string | null
          confidence: string
          counts_across: string
          created_at: string
          household_id: string
          id: string
          lottery_id: string | null
          max_count: number
          memo: string
          scope_type: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          basis: string
          campaign_id?: string | null
          chain_id?: string | null
          confidence?: string
          counts_across?: string
          created_at?: string
          household_id: string
          id?: string
          lottery_id?: string | null
          max_count?: number
          memo?: string
          scope_type: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          basis?: string
          campaign_id?: string | null
          chain_id?: string | null
          confidence?: string
          counts_across?: string
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string | null
          max_count?: number
          memo?: string
          scope_type?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_rules_campaign_id_household_id_fkey"
            columns: ["campaign_id", "household_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_rules_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      applications: {
        Row: {
          applied_at: string | null
          created_at: string
          fulfillment_status: string
          household_id: string
          id: string
          lottery_id: string
          origin: string
          procedure_completed_at: string | null
          result_confirmed_at: string | null
          result_status: string
          service_account_id: string
          state: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          fulfillment_status?: string
          household_id: string
          id?: string
          lottery_id: string
          origin?: string
          procedure_completed_at?: string | null
          result_confirmed_at?: string | null
          result_status?: string
          service_account_id: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          fulfillment_status?: string
          household_id?: string
          id?: string
          lottery_id?: string
          origin?: string
          procedure_completed_at?: string | null
          result_confirmed_at?: string | null
          result_status?: string
          service_account_id?: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "applications_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "applications_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_auth_user_id: string | null
          actor_profile_id: string | null
          after_json: Json | null
          before_json: Json | null
          entity_id: string | null
          entity_type: string
          household_id: string
          id: string
          occurred_at: string
        }
        Insert: {
          action: string
          actor_auth_user_id?: string | null
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          entity_id?: string | null
          entity_type: string
          household_id: string
          id?: string
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_auth_user_id?: string | null
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          entity_id?: string | null
          entity_type?: string
          household_id?: string
          id?: string
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_profile_id_household_id_fkey"
            columns: ["actor_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "audit_logs_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          chain_id: string
          created_at: string
          household_id: string
          id: string
          name: string
          store_rule: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          name: string
          store_rule?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          name?: string
          store_rule?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "campaigns_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      chain_requirements: {
        Row: {
          archived_at: string | null
          chain_id: string
          created_at: string
          description: string
          household_id: string
          id: string
          kind: string
          label: string
          min_purchase_amount_yen: number | null
          min_purchase_count: number | null
          updated_at: string
          updated_by_profile_id: string | null
          valid_months: number | null
        }
        Insert: {
          archived_at?: string | null
          chain_id: string
          created_at?: string
          description?: string
          household_id: string
          id?: string
          kind: string
          label: string
          min_purchase_amount_yen?: number | null
          min_purchase_count?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_months?: number | null
        }
        Update: {
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          description?: string
          household_id?: string
          id?: string
          kind?: string
          label?: string
          min_purchase_amount_yen?: number | null
          min_purchase_count?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_months?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "chain_requirements_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "chain_requirements_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chain_requirements_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      chains: {
        Row: {
          archived_at: string | null
          created_at: string
          default_application_rule: string
          household_id: string
          id: string
          memo: string
          name: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          default_application_rule?: string
          household_id: string
          id?: string
          memo?: string
          name: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          default_application_rule?: string
          household_id?: string
          id?: string
          memo?: string
          name?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chains_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chains_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      eligibility_purchases: {
        Row: {
          amount_yen: number | null
          archived_at: string | null
          counts_until: string | null
          created_at: string
          household_id: string
          id: string
          note: string
          purchased_on: string | null
          quantity: number | null
          service_account_id: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          amount_yen?: number | null
          archived_at?: string | null
          counts_until?: string | null
          created_at?: string
          household_id: string
          id?: string
          note?: string
          purchased_on?: string | null
          quantity?: number | null
          service_account_id: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          amount_yen?: number | null
          archived_at?: string | null
          counts_until?: string | null
          created_at?: string
          household_id?: string
          id?: string
          note?: string
          purchased_on?: string | null
          quantity?: number | null
          service_account_id?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eligibility_purchases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eligibility_purchases_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "eligibility_purchases_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "eligibility_purchases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      family_groups: {
        Row: {
          archived_at: string | null
          created_at: string
          household_id: string
          id: string
          label: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          household_id: string
          id?: string
          label: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          household_id?: string
          id?: string
          label?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "family_groups_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_groups_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      household_members: {
        Row: {
          created_at: string
          household_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          household_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          household_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_members_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      households: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_auth_user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          owner_auth_user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_auth_user_id?: string
        }
        Relationships: []
      }
      identities: {
        Row: {
          address_group_id: string
          archived_at: string | null
          created_at: string
          display_label: string
          family_group_id: string
          household_id: string
          id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          address_group_id: string
          archived_at?: string | null
          created_at?: string
          display_label: string
          family_group_id: string
          household_id: string
          id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          address_group_id?: string
          archived_at?: string | null
          created_at?: string
          display_label?: string
          family_group_id?: string
          household_id?: string
          id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "identities_address_group_id_household_id_fkey"
            columns: ["address_group_id", "household_id"]
            isOneToOne: false
            referencedRelation: "address_groups"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "identities_family_group_id_household_id_fkey"
            columns: ["family_group_id", "household_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "identities_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identities_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      limit_exemptions: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          reason: string
          service_account_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          reason?: string
          service_account_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          reason?: string
          service_account_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "limit_exemptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "limit_exemptions_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "limit_exemptions_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "limit_exemptions_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lotteries: {
        Row: {
          announcement_method: string
          announcement_url: string | null
          apply_deadline_at: string | null
          apply_deadline_date: string | null
          apply_deadline_precision: string
          apply_method: string
          apply_start_at: string | null
          apply_start_date: string | null
          apply_start_precision: string
          archived_at: string | null
          campaign_id: string | null
          chain_id: string
          conditions_text: string
          created_at: string
          event_state: string
          household_id: string
          id: string
          is_new: boolean
          limit_basis: string
          limit_max_count: number
          memo: string
          procedure_deadline_at: string | null
          procedure_deadline_date: string | null
          procedure_deadline_precision: string
          receive_method: string
          result_at: string | null
          result_date: string | null
          result_precision: string
          source_kind: string
          source_urls: string[]
          store_id: string
          updated_at: string
          updated_by_profile_id: string | null
          verification_text: string
        }
        Insert: {
          announcement_method?: string
          announcement_url?: string | null
          apply_deadline_at?: string | null
          apply_deadline_date?: string | null
          apply_deadline_precision?: string
          apply_method?: string
          apply_start_at?: string | null
          apply_start_date?: string | null
          apply_start_precision?: string
          archived_at?: string | null
          campaign_id?: string | null
          chain_id: string
          conditions_text?: string
          created_at?: string
          event_state?: string
          household_id: string
          id?: string
          is_new?: boolean
          limit_basis?: string
          limit_max_count?: number
          memo?: string
          procedure_deadline_at?: string | null
          procedure_deadline_date?: string | null
          procedure_deadline_precision?: string
          receive_method?: string
          result_at?: string | null
          result_date?: string | null
          result_precision?: string
          source_kind?: string
          source_urls?: string[]
          store_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
          verification_text?: string
        }
        Update: {
          announcement_method?: string
          announcement_url?: string | null
          apply_deadline_at?: string | null
          apply_deadline_date?: string | null
          apply_deadline_precision?: string
          apply_method?: string
          apply_start_at?: string | null
          apply_start_date?: string | null
          apply_start_precision?: string
          archived_at?: string | null
          campaign_id?: string | null
          chain_id?: string
          conditions_text?: string
          created_at?: string
          event_state?: string
          household_id?: string
          id?: string
          is_new?: boolean
          limit_basis?: string
          limit_max_count?: number
          memo?: string
          procedure_deadline_at?: string | null
          procedure_deadline_date?: string | null
          procedure_deadline_precision?: string
          receive_method?: string
          result_at?: string | null
          result_date?: string | null
          result_precision?: string
          source_kind?: string
          source_urls?: string[]
          store_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          verification_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "lotteries_campaign_id_household_id_fkey"
            columns: ["campaign_id", "household_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lotteries_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lottery_items: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          product_id: string
          quantity: number
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          product_id: string
          quantity: number
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          product_id?: string
          quantity?: number
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lottery_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lottery_items_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_items_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_items_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lottery_management: {
        Row: {
          created_at: string
          household_id: string
          is_managed: boolean
          lottery_id: string
          managed_at: string | null
          managed_source: string
          reviewed_at: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          is_managed?: boolean
          lottery_id: string
          managed_at?: string | null
          managed_source?: string
          reviewed_at?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          is_managed?: boolean
          lottery_id?: string
          managed_at?: string | null
          managed_source?: string
          reviewed_at?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lottery_management_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lottery_management_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_management_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      notification_cron_calls: {
        Row: {
          called_at: string
          error_msg: string | null
          harvested_at: string | null
          id: number
          request_id: number | null
          status_code: number | null
        }
        Insert: {
          called_at?: string
          error_msg?: string | null
          harvested_at?: string | null
          id?: never
          request_id?: number | null
          status_code?: number | null
        }
        Update: {
          called_at?: string
          error_msg?: string | null
          harvested_at?: string | null
          id?: never
          request_id?: number | null
          status_code?: number | null
        }
        Relationships: []
      }
      notification_deliveries: {
        Row: {
          application_id: string | null
          attempts: number
          created_at: string
          error_code: string | null
          household_id: string
          id: string
          lottery_id: string | null
          profile_id: string
          sent_at: string | null
          status: string
          trigger_key: string
          type: string
        }
        Insert: {
          application_id?: string | null
          attempts?: number
          created_at?: string
          error_code?: string | null
          household_id: string
          id?: string
          lottery_id?: string | null
          profile_id: string
          sent_at?: string | null
          status: string
          trigger_key: string
          type: string
        }
        Update: {
          application_id?: string | null
          attempts?: number
          created_at?: string
          error_code?: string | null
          household_id?: string
          id?: string
          lottery_id?: string | null
          profile_id?: string
          sent_at?: string | null
          status?: string
          trigger_key?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      notification_job_runs: {
        Row: {
          duplicates: number | null
          duration_ms: number | null
          error_code: string | null
          failed: number | null
          finished_at: string | null
          id: string
          no_device: number | null
          planned: number | null
          sent: number | null
          started_at: string
          status: string
          suppressed: number | null
          trigger: string
        }
        Insert: {
          duplicates?: number | null
          duration_ms?: number | null
          error_code?: string | null
          failed?: number | null
          finished_at?: string | null
          id?: string
          no_device?: number | null
          planned?: number | null
          sent?: number | null
          started_at?: string
          status?: string
          suppressed?: number | null
          trigger?: string
        }
        Update: {
          duplicates?: number | null
          duration_ms?: number | null
          error_code?: string | null
          failed?: number | null
          finished_at?: string | null
          id?: string
          no_device?: number | null
          planned?: number | null
          sent?: number | null
          started_at?: string
          status?: string
          suppressed?: number | null
          trigger?: string
        }
        Relationships: []
      }
      notification_settings: {
        Row: {
          created_at: string
          date_only_policy: string
          deadline_offsets_min: number[]
          eligibility_expiry_days: number
          enabled: boolean
          household_id: string
          id: string
          morning_time: string
          procedure_enabled: boolean
          procedure_lead_hours: number[]
          profile_id: string
          result_enabled: boolean
          result_reminder_hours: number[]
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          date_only_policy?: string
          deadline_offsets_min?: number[]
          eligibility_expiry_days?: number
          enabled?: boolean
          household_id: string
          id?: string
          morning_time?: string
          procedure_enabled?: boolean
          procedure_lead_hours?: number[]
          profile_id: string
          result_enabled?: boolean
          result_reminder_hours?: number[]
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          date_only_policy?: string
          deadline_offsets_min?: number[]
          eligibility_expiry_days?: number
          enabled?: boolean
          household_id?: string
          id?: string
          morning_time?: string
          procedure_enabled?: boolean
          procedure_lead_hours?: number[]
          profile_id?: string
          result_enabled?: boolean
          result_reminder_hours?: number[]
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_settings_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_settings_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "notification_settings_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_aliases: {
        Row: {
          alias: string
          created_at: string
          household_id: string
          id: string
          normalized_alias: string
          product_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          alias: string
          created_at?: string
          household_id: string
          id?: string
          normalized_alias: string
          product_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          alias?: string
          created_at?: string
          household_id?: string
          id?: string
          normalized_alias?: string
          product_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_aliases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_aliases_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_aliases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_prices: {
        Row: {
          amount_yen: number
          created_at: string
          household_id: string
          id: string
          product_id: string
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          amount_yen: number
          created_at?: string
          household_id: string
          id?: string
          product_id: string
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          amount_yen?: number
          created_at?: string
          household_id?: string
          id?: string
          product_id?: string
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_prices_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_prices_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_prices_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      products: {
        Row: {
          archived_at: string | null
          box_image_ref: string | null
          category: string
          created_at: string
          household_id: string
          id: string
          official_name: string
          pack_image_ref: string | null
          packs_per_box: number
          product_code: string | null
          release_date: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          box_image_ref?: string | null
          category?: string
          created_at?: string
          household_id: string
          id?: string
          official_name: string
          pack_image_ref?: string | null
          packs_per_box?: number
          product_code?: string | null
          release_date?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          box_image_ref?: string | null
          category?: string
          created_at?: string
          household_id?: string
          id?: string
          official_name?: string
          pack_image_ref?: string | null
          packs_per_box?: number
          product_code?: string | null
          release_date?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      profile_target_rules: {
        Row: {
          chain_id: string
          created_at: string
          household_id: string
          id: string
          mode: string
          profile_id: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          mode: string
          profile_id: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          mode?: string
          profile_id?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_target_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_target_rules_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_store_fk"
            columns: ["store_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          color: string
          created_at: string
          household_id: string
          id: string
          initial: string
          label: string
          sort_order: number
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          active?: boolean
          color?: string
          created_at?: string
          household_id: string
          id?: string
          initial: string
          label: string
          sort_order?: number
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          active?: boolean
          color?: string
          created_at?: string
          household_id?: string
          id?: string
          initial?: string
          label?: string
          sort_order?: number
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      purchase_items: {
        Row: {
          amount_paid: number | null
          created_at: string
          household_id: string
          id: string
          product_id: string | null
          purchase_id: string
          quantity: number
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          amount_paid?: number | null
          created_at?: string
          household_id: string
          id?: string
          product_id?: string | null
          purchase_id: string
          quantity: number
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          amount_paid?: number | null
          created_at?: string
          household_id?: string
          id?: string
          product_id?: string | null
          purchase_id?: string
          quantity?: number
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchase_items_purchase_id_household_id_fkey"
            columns: ["purchase_id", "household_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchase_items_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      purchases: {
        Row: {
          application_id: string | null
          buyer_profile_id: string | null
          channel: string
          created_at: string
          household_id: string
          id: string
          note: string
          purchased_at: string | null
          purchased_date: string | null
          record_kind: string
          source_kind: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          application_id?: string | null
          buyer_profile_id?: string | null
          channel?: string
          created_at?: string
          household_id: string
          id?: string
          note?: string
          purchased_at?: string | null
          purchased_date?: string | null
          record_kind?: string
          source_kind?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          application_id?: string | null
          buyer_profile_id?: string | null
          channel?: string
          created_at?: string
          household_id?: string
          id?: string
          note?: string
          purchased_at?: string | null
          purchased_date?: string | null
          record_kind?: string
          source_kind?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchases_application_id_household_id_fkey"
            columns: ["application_id", "household_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_buyer_profile_id_household_id_fkey"
            columns: ["buyer_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          device_label: string
          enabled: boolean
          endpoint: string
          failure_count: number
          household_id: string
          id: string
          last_seen_at: string
          p256dh: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          auth: string
          created_at?: string
          device_label?: string
          enabled?: boolean
          endpoint: string
          failure_count?: number
          household_id: string
          id?: string
          last_seen_at?: string
          p256dh: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          auth?: string
          created_at?: string
          device_label?: string
          enabled?: boolean
          endpoint?: string
          failure_count?: number
          household_id?: string
          id?: string
          last_seen_at?: string
          p256dh?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      service_accounts: {
        Row: {
          account_label: string
          active: boolean
          chain_id: string
          created_at: string
          household_id: string
          id: string
          identity_id: string
          managed_by_profile_id: string
          membership_state: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          account_label: string
          active?: boolean
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          identity_id: string
          managed_by_profile_id: string
          membership_state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          account_label?: string
          active?: boolean
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          identity_id?: string
          managed_by_profile_id?: string
          membership_state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_accounts_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_accounts_identity_id_household_id_fkey"
            columns: ["identity_id", "household_id"]
            isOneToOne: false
            referencedRelation: "identities"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_managed_by_profile_id_household_id_fkey"
            columns: ["managed_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      skip_rule_exceptions: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          skip_rule_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          skip_rule_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          skip_rule_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skip_rule_exceptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_skip_rule_id_household_id_fkey"
            columns: ["skip_rule_id", "household_id"]
            isOneToOne: false
            referencedRelation: "skip_rules"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      skip_rules: {
        Row: {
          chain_id: string | null
          created_at: string
          household_id: string
          id: string
          lottery_id: string | null
          profile_id: string
          scope_type: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id?: string | null
          created_at?: string
          household_id: string
          id?: string
          lottery_id?: string | null
          profile_id: string
          scope_type: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string | null
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string | null
          profile_id?: string
          scope_type?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skip_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skip_rules_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      stores: {
        Row: {
          address_optional: string
          archived_at: string | null
          chain_id: string
          created_at: string
          household_id: string
          id: string
          latitude: number | null
          longitude: number | null
          name: string
          nearest_station: string
          parking_memo: string
          prefecture: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          address_optional?: string
          archived_at?: string | null
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name: string
          nearest_station?: string
          parking_memo?: string
          prefecture?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          address_optional?: string
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string
          nearest_station?: string
          parking_memo?: string
          prefecture?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stores_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "stores_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stores_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_household: { Args: never; Returns: string }
      flex_ok: { Args: { d: string; p: string; t: string }; Returns: boolean }
      invoke_notify_job: {
        Args: { p_secret?: string; p_url?: string }
        Returns: number
      }
      is_household_member: { Args: { hid: string }; Returns: boolean }
      is_test_household: { Args: { hid: string }; Returns: boolean }
      mark_purchased: {
        Args: { p_actor: string; p_application_id: string }
        Returns: undefined
      }
      notification_cron_disable: { Args: never; Returns: boolean }
      notification_cron_enable: {
        Args: { p_schedule?: string }
        Returns: number
      }
      notification_job_status: {
        Args: never
        Returns: {
          last_run_at: string
          last_status: string
          last_success_at: string
          scheduled: boolean
        }[]
      }
      purge_test_households: {
        Args: never
        Returns: {
          owner_email: string
          purged_household: string
        }[]
      }
      push_subscription_status: {
        Args: { p_endpoint: string }
        Returns: {
          enabled: boolean
          profile_id: string
        }[]
      }
      rebind_push_subscription: {
        Args: { p_endpoint: string; p_profile: string }
        Returns: boolean
      }
      register_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_label: string
          p_p256dh: string
          p_profile: string
        }
        Returns: undefined
      }
      remove_push_subscription: {
        Args: { p_endpoint: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
